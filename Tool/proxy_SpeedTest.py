#!/usr/bin/env python3
"""
测速流程
它会对每个节点执行：

1. 连接代理服务器
2. 如果代理地址是 `https://`，先和代理建立 TLS
3. 通过 `CONNECT` 建立到目标站点的 HTTPS 隧道
4. 访问测试 URL，记录 TTFB、总耗时和下载吞吐
5. 按可用性、下载速度、TTFB 排序输出


准备代理列表：
新建一个txt，参考以下格式填写。
e.g. HK-01,http://1.2.3.4:8080
e.g. SG-01,https://user:password@example.com:443
e.g. US-01 5.6.7.8:3128
```
"""

from __future__ import annotations

import argparse
import base64
import csv
import json
import os
import queue
import socket
import ssl
import sys
import threading
import time
import tkinter as tk
import tkinter.font as tkfont
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass
from tkinter import filedialog, messagebox, ttk
from typing import Iterable, Optional
from urllib.parse import unquote, urlsplit


APP_TITLE = "Proxy Speed Test"
DEFAULT_PROXY_FILE = "proxies.noapp.test.txt"
DEFAULT_TEST_URL = "https://speed.cloudflare.com/__down?bytes=262144"
DEFAULT_BYTES = 256 * 1024
MAX_HEADER_BYTES = 64 * 1024
USER_AGENT = "proxy-speed-test/1.0"


class ProxyParseError(ValueError):
    pass


@dataclass(frozen=True)
class ProxyNode:
    line_no: int
    name: str
    raw: str
    scheme: str
    host: str
    port: int
    username: Optional[str]
    password: Optional[str]
    display_url: str


@dataclass(frozen=True)
class Target:
    url: str
    host: str
    port: int
    path: str


@dataclass
class TestResult:
    line_no: int
    name: str
    proxy: str
    ok: bool
    status: str
    error: str = ""
    target_status: Optional[int] = None
    tcp_ms: Optional[float] = None
    proxy_tls_ms: Optional[float] = None
    connect_ms: Optional[float] = None
    target_tls_ms: Optional[float] = None
    ttfb_ms: Optional[float] = None
    total_ms: Optional[float] = None
    bytes_read: int = 0
    download_ms: Optional[float] = None
    speed_mbps: float = 0.0


class NestedTLSConnection:
    """TLS over an already-connected transport, used for HTTPS proxies.

    ssl.wrap_socket() cannot reliably layer a second TLS session over an
    existing SSLSocket. MemoryBIO lets us encrypt/decrypt the inner TLS stream
    while sending its ciphertext as normal application data through the proxy.
    """

    def __init__(self, transport: socket.socket, context: ssl.SSLContext, server_hostname: str):
        self.transport = transport
        self.incoming = ssl.MemoryBIO()
        self.outgoing = ssl.MemoryBIO()
        self.ssl_object = context.wrap_bio(
            self.incoming,
            self.outgoing,
            server_side=False,
            server_hostname=server_hostname,
        )
        self._do_handshake()

    def settimeout(self, timeout: float) -> None:
        self.transport.settimeout(timeout)

    def _flush_outgoing(self) -> None:
        while True:
            data = self.outgoing.read()
            if not data:
                return
            self.transport.sendall(data)

    def _feed_incoming(self) -> bool:
        data = self.transport.recv(64 * 1024)
        if not data:
            self.incoming.write_eof()
            return False
        self.incoming.write(data)
        return True

    def _do_handshake(self) -> None:
        while True:
            try:
                self.ssl_object.do_handshake()
                self._flush_outgoing()
                return
            except ssl.SSLWantReadError:
                self._flush_outgoing()
                if not self._feed_incoming():
                    raise RuntimeError("connection closed during nested TLS handshake")
            except ssl.SSLWantWriteError:
                self._flush_outgoing()

    def sendall(self, data: bytes) -> None:
        remaining = memoryview(data)
        while remaining:
            try:
                written = self.ssl_object.write(remaining)
                remaining = remaining[written:]
                self._flush_outgoing()
            except ssl.SSLWantReadError:
                self._flush_outgoing()
                if not self._feed_incoming():
                    raise RuntimeError("connection closed during nested TLS write")
            except ssl.SSLWantWriteError:
                self._flush_outgoing()

    def recv(self, size: int) -> bytes:
        while True:
            try:
                data = self.ssl_object.read(size)
                self._flush_outgoing()
                return data
            except ssl.SSLWantReadError:
                self._flush_outgoing()
                if not self._feed_incoming():
                    return b""
            except ssl.SSLWantWriteError:
                self._flush_outgoing()
            except ssl.SSLZeroReturnError:
                return b""

    def close(self) -> None:
        try:
            self.transport.close()
        except OSError:
            pass


def parse_size(value: str) -> int:
    text = value.strip().lower()
    if not text:
        raise argparse.ArgumentTypeError("size cannot be empty")

    multiplier = 1
    if text[-1] in {"k", "m", "g"}:
        suffix = text[-1]
        text = text[:-1]
        multiplier = {"k": 1024, "m": 1024**2, "g": 1024**3}[suffix]
    elif text.endswith("kb"):
        text = text[:-2]
        multiplier = 1024
    elif text.endswith("mb"):
        text = text[:-2]
        multiplier = 1024**2

    try:
        size = int(float(text) * multiplier)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"invalid size: {value}") from exc

    if size < 0:
        raise argparse.ArgumentTypeError("size must be >= 0")
    return size


def strip_inline_comment(line: str) -> str:
    text = line.strip()
    if not text or text.startswith("#"):
        return ""

    for marker in (" #", "\t#"):
        index = text.find(marker)
        if index >= 0:
            text = text[:index].strip()
    return text


def looks_like_proxy(value: str) -> bool:
    text = value.strip()
    if not text:
        return False
    return "://" in text or ":" in text or "@" in text


def split_name_and_proxy(line: str) -> tuple[Optional[str], str]:
    if "," in line:
        left, right = [part.strip() for part in line.split(",", 1)]
        if looks_like_proxy(right) and not looks_like_proxy(left):
            return left or None, right
        if looks_like_proxy(left) and not looks_like_proxy(right):
            return right or None, left

    parts = line.split()
    if len(parts) >= 2:
        first, second = parts[0].strip(), parts[1].strip()
        if looks_like_proxy(second) and not looks_like_proxy(first):
            return first or None, second
        if looks_like_proxy(first) and not looks_like_proxy(second):
            return second or None, first

    return None, line.strip()


def _host_for_url(host: str) -> str:
    if ":" in host and not host.startswith("["):
        return f"[{host}]"
    return host


def parse_proxy_line(line: str, line_no: int) -> Optional[ProxyNode]:
    cleaned = strip_inline_comment(line)
    if not cleaned:
        return None

    name, value = split_name_and_proxy(cleaned)
    raw = value
    if "://" not in value:
        value = f"http://{value}"

    parsed = urlsplit(value)
    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https"}:
        raise ProxyParseError(f"line {line_no}: unsupported proxy scheme '{parsed.scheme}'")
    if not parsed.hostname:
        raise ProxyParseError(f"line {line_no}: missing proxy host")

    try:
        port = parsed.port
    except ValueError as exc:
        raise ProxyParseError(f"line {line_no}: invalid proxy port") from exc
    if port is None:
        port = 443 if scheme == "https" else 80

    username = unquote(parsed.username) if parsed.username else None
    password = unquote(parsed.password) if parsed.password else None
    host = parsed.hostname
    display_host = _host_for_url(host)
    user_part = "***@" if username else ""
    display_url = f"{scheme}://{user_part}{display_host}:{port}"
    display_name = name or f"{host}:{port}"

    return ProxyNode(
        line_no=line_no,
        name=display_name,
        raw=raw,
        scheme=scheme,
        host=host,
        port=port,
        username=username,
        password=password,
        display_url=display_url,
    )


def load_proxy_file(path: str) -> tuple[list[ProxyNode], list[str]]:
    nodes: list[ProxyNode] = []
    errors: list[str] = []
    with open(path, "r", encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, 1):
            try:
                node = parse_proxy_line(line, line_no)
            except ProxyParseError as exc:
                errors.append(str(exc))
                continue
            if node:
                nodes.append(node)
    return nodes, errors


def parse_target_url(url: str) -> Target:
    parsed = urlsplit(url)
    if parsed.scheme.lower() != "https":
        raise ValueError("test URL must use https://")
    if not parsed.hostname:
        raise ValueError("test URL is missing host")
    try:
        port = parsed.port or 443
    except ValueError as exc:
        raise ValueError("test URL has invalid port") from exc

    path = parsed.path or "/"
    if parsed.query:
        path = f"{path}?{parsed.query}"
    return Target(url=url, host=parsed.hostname, port=port, path=path)


def make_ssl_context(insecure: bool) -> ssl.SSLContext:
    if insecure:
        return ssl._create_unverified_context()
    return ssl.create_default_context()


def read_http_headers(sock: socket.socket) -> tuple[bytes, Optional[float]]:
    data = bytearray()
    first_byte_at: Optional[float] = None
    while b"\r\n\r\n" not in data:
        chunk = sock.recv(4096)
        now = time.perf_counter()
        if chunk and first_byte_at is None:
            first_byte_at = now
        if not chunk:
            break
        data.extend(chunk)
        if len(data) > MAX_HEADER_BYTES:
            raise RuntimeError("HTTP response headers are too large")
    return bytes(data), first_byte_at


def parse_http_status(header_bytes: bytes) -> tuple[int, str]:
    first_line = header_bytes.split(b"\r\n", 1)[0].decode("iso-8859-1", errors="replace")
    parts = first_line.split(" ", 2)
    if len(parts) < 2 or not parts[1].isdigit():
        raise RuntimeError(f"invalid HTTP response line: {first_line!r}")
    reason = parts[2] if len(parts) > 2 else ""
    return int(parts[1]), reason


def build_connect_request(node: ProxyNode, target: Target) -> bytes:
    authority = f"{target.host}:{target.port}"
    lines = [
        f"CONNECT {authority} HTTP/1.1",
        f"Host: {authority}",
        f"User-Agent: {USER_AGENT}",
        "Proxy-Connection: Keep-Alive",
    ]
    if node.username is not None:
        password = node.password or ""
        token = base64.b64encode(f"{node.username}:{password}".encode("utf-8")).decode("ascii")
        lines.append(f"Proxy-Authorization: Basic {token}")
    lines.extend(["", ""])
    return "\r\n".join(lines).encode("ascii")


def establish_tunnel(
    node: ProxyNode,
    target: Target,
    connect_timeout: float,
    read_timeout: float,
    target_ssl_context: ssl.SSLContext,
    proxy_ssl_context: ssl.SSLContext,
) -> tuple[object, dict[str, float]]:
    metrics: dict[str, float] = {}
    tcp_started = time.perf_counter()
    raw_sock = socket.create_connection((node.host, node.port), timeout=connect_timeout)
    raw_sock.settimeout(read_timeout)
    metrics["tcp_ms"] = (time.perf_counter() - tcp_started) * 1000

    sock: socket.socket = raw_sock
    try:
        if node.scheme == "https":
            tls_started = time.perf_counter()
            sock = proxy_ssl_context.wrap_socket(raw_sock, server_hostname=node.host)
            sock.settimeout(read_timeout)
            metrics["proxy_tls_ms"] = (time.perf_counter() - tls_started) * 1000

        connect_started = time.perf_counter()
        sock.sendall(build_connect_request(node, target))
        response, _ = read_http_headers(sock)
        connect_ms = (time.perf_counter() - connect_started) * 1000
        if b"\r\n\r\n" not in response:
            raise RuntimeError("proxy closed before CONNECT response completed")
        header_bytes = response.split(b"\r\n\r\n", 1)[0]
        status_code, reason = parse_http_status(header_bytes)
        if status_code != 200:
            reason_text = f" {reason}" if reason else ""
            raise RuntimeError(f"CONNECT failed with HTTP {status_code}{reason_text}")
        metrics["connect_ms"] = connect_ms

        target_tls_started = time.perf_counter()
        if node.scheme == "https":
            tls_sock = NestedTLSConnection(sock, target_ssl_context, target.host)
        else:
            tls_sock = target_ssl_context.wrap_socket(sock, server_hostname=target.host)
        tls_sock.settimeout(read_timeout)
        metrics["target_tls_ms"] = (time.perf_counter() - target_tls_started) * 1000
        return tls_sock, metrics
    except Exception:
        sock.close()
        raise


def fetch_through_tunnel(
    tls_sock: object,
    target: Target,
    max_bytes: int,
) -> tuple[int, float, int, Optional[float], float]:
    request = (
        f"GET {target.path} HTTP/1.1\r\n"
        f"Host: {target.host}\r\n"
        f"User-Agent: {USER_AGENT}\r\n"
        "Accept: */*\r\n"
        "Connection: close\r\n"
        "\r\n"
    ).encode("ascii")

    sent_at = time.perf_counter()
    tls_sock.sendall(request)
    response, first_byte_at = read_http_headers(tls_sock)
    if not response:
        raise RuntimeError("target closed without response")
    if b"\r\n\r\n" not in response:
        raise RuntimeError("target closed before response headers completed")

    header_bytes, body = response.split(b"\r\n\r\n", 1)
    status_code, _ = parse_http_status(header_bytes)
    ttfb_ms = ((first_byte_at or time.perf_counter()) - sent_at) * 1000

    body_bytes = 0
    body_started_at: Optional[float] = None
    body_finished_at: Optional[float] = None
    if max_bytes > 0:
        initial = body[:max_bytes]
        body_bytes = len(initial)
        if body_bytes:
            body_started_at = first_byte_at or time.perf_counter()
            body_finished_at = time.perf_counter()

        while body_bytes < max_bytes:
            chunk = tls_sock.recv(min(64 * 1024, max_bytes - body_bytes))
            now = time.perf_counter()
            if not chunk:
                break
            if body_started_at is None:
                body_started_at = now
            body_bytes += len(chunk)
            body_finished_at = now

    download_ms: Optional[float] = None
    speed_mbps = 0.0
    if body_started_at is not None and body_finished_at is not None:
        download_ms = max((body_finished_at - body_started_at) * 1000, 0.001)
        speed_mbps = (body_bytes * 8) / (download_ms / 1000) / 1_000_000

    return status_code, ttfb_ms, body_bytes, download_ms, speed_mbps


def test_proxy(
    node: ProxyNode,
    target: Target,
    max_bytes: int,
    connect_timeout: float,
    read_timeout: float,
    target_ssl_context: ssl.SSLContext,
    proxy_ssl_context: ssl.SSLContext,
) -> TestResult:
    total_started = time.perf_counter()
    tls_sock: Optional[object] = None
    try:
        tls_sock, metrics = establish_tunnel(
            node=node,
            target=target,
            connect_timeout=connect_timeout,
            read_timeout=read_timeout,
            target_ssl_context=target_ssl_context,
            proxy_ssl_context=proxy_ssl_context,
        )
        status_code, ttfb_ms, bytes_read, download_ms, speed_mbps = fetch_through_tunnel(
            tls_sock=tls_sock,
            target=target,
            max_bytes=max_bytes,
        )
        total_ms = (time.perf_counter() - total_started) * 1000
        ok = 200 <= status_code < 400
        return TestResult(
            line_no=node.line_no,
            name=node.name,
            proxy=node.display_url,
            ok=ok,
            status="ok" if ok else f"http_{status_code}",
            error="" if ok else f"target returned HTTP {status_code}",
            target_status=status_code,
            tcp_ms=metrics.get("tcp_ms"),
            proxy_tls_ms=metrics.get("proxy_tls_ms"),
            connect_ms=metrics.get("connect_ms"),
            target_tls_ms=metrics.get("target_tls_ms"),
            ttfb_ms=ttfb_ms,
            total_ms=total_ms,
            bytes_read=bytes_read,
            download_ms=download_ms,
            speed_mbps=speed_mbps,
        )
    except socket.timeout as exc:
        return failure_result(node, "timeout", str(exc), total_started)
    except ssl.SSLError as exc:
        return failure_result(node, "tls_error", str(exc), total_started)
    except OSError as exc:
        return failure_result(node, "network_error", str(exc), total_started)
    except Exception as exc:
        return failure_result(node, "error", str(exc), total_started)
    finally:
        if tls_sock is not None:
            try:
                tls_sock.close()
            except OSError:
                pass


def failure_result(node: ProxyNode, status: str, error: str, total_started: float) -> TestResult:
    return TestResult(
        line_no=node.line_no,
        name=node.name,
        proxy=node.display_url,
        ok=False,
        status=status,
        error=error,
        total_ms=(time.perf_counter() - total_started) * 1000,
    )


def sorted_results(results: Iterable[TestResult]) -> list[TestResult]:
    def key(result: TestResult) -> tuple[int, float, float, float, str]:
        ttfb = result.ttfb_ms if result.ttfb_ms is not None else float("inf")
        total = result.total_ms if result.total_ms is not None else float("inf")
        return (0 if result.ok else 1, -result.speed_mbps, ttfb, total, result.name)

    return sorted(results, key=key)


def format_ms(value: Optional[float]) -> str:
    if value is None:
        return "-"
    return f"{value:.0f}"


def format_mbps(value: float) -> str:
    if value <= 0:
        return "-"
    return f"{value:.2f}"


def shorten(value: str, width: int) -> str:
    if len(value) <= width:
        return value
    return value[: max(0, width - 3)] + "..."


def render_table(results: list[TestResult], top: Optional[int] = None) -> str:
    selected = results[:top] if top else results
    rows = [
        [
            "#",
            "name",
            "status",
            "speed(Mbps)",
            "ttfb(ms)",
            "total(ms)",
            "bytes",
            "proxy",
            "error",
        ]
    ]
    for index, result in enumerate(selected, 1):
        rows.append(
            [
                str(index),
                result.name,
                result.status,
                format_mbps(result.speed_mbps),
                format_ms(result.ttfb_ms),
                format_ms(result.total_ms),
                str(result.bytes_read or "-"),
                result.proxy,
                result.error,
            ]
        )

    widths = [4, 22, 13, 12, 9, 10, 8, 34, 36]
    lines = []
    for row_index, row in enumerate(rows):
        cells = [shorten(cell, widths[i]).ljust(widths[i]) for i, cell in enumerate(row)]
        lines.append("  ".join(cells).rstrip())
        if row_index == 0:
            lines.append("  ".join("-" * width for width in widths).rstrip())
    return "\n".join(lines)


def write_csv(path: str, results: list[TestResult]) -> None:
    fields = list(asdict(results[0]).keys()) if results else list(TestResult.__dataclass_fields__.keys())
    with open(path, "w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for result in results:
            writer.writerow(asdict(result))


def write_json(path: str, results: list[TestResult]) -> None:
    with open(path, "w", encoding="utf-8") as handle:
        json.dump([asdict(result) for result in results], handle, ensure_ascii=False, indent=2)
        handle.write("\n")


class ProxySpeedApp:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title(APP_TITLE)
        self.root.geometry("1120x720")
        self.root.minsize(960, 620)

        self.events: queue.Queue[tuple[str, object]] = queue.Queue()
        self.results: list[TestResult] = []
        self.total_nodes = 0
        self.completed_nodes = 0
        self.running = False
        self.run_token = 0

        self.file_var = tk.StringVar(value=self._default_proxy_file())
        self.url_var = tk.StringVar(value=DEFAULT_TEST_URL)
        self.workers_var = tk.StringVar(value="2")
        self.bytes_var = tk.StringVar(value="64k")
        self.connect_timeout_var = tk.StringVar(value="5")
        self.read_timeout_var = tk.StringVar(value="10")
        self.insecure_proxy_var = tk.BooleanVar(value=True)
        self.insecure_target_var = tk.BooleanVar(value=True)
        self.status_var = tk.StringVar(value="Ready")

        self._configure_style()
        self._build_layout()
        self._poll_events()

    def _default_proxy_file(self) -> str:
        path = os.path.abspath(DEFAULT_PROXY_FILE)
        return path if os.path.exists(path) else ""

    def _configure_style(self) -> None:
        try:
            self.root.tk.call("tk", "scaling", 1.0)
        except tk.TclError:
            pass

        for font_name in ("TkDefaultFont", "TkTextFont", "TkMenuFont"):
            font = tkfont.nametofont(font_name)
            font.configure(family=".AppleSystemUIFont", size=13)
        try:
            tkfont.nametofont("TkHeadingFont").configure(
                family=".AppleSystemUIFont",
                size=13,
                weight="bold",
            )
        except tk.TclError:
            pass

        self.style = ttk.Style()
        if "aqua" in self.style.theme_names():
            self.style.theme_use("aqua")
        self.style.configure("Root.TFrame", background="#f5f5f7")
        self.style.configure("Panel.TFrame", background="#f5f5f7")
        self.style.configure("Status.TLabel", background="#f5f5f7", foreground="#6e6e73")
        self.style.configure("Title.TLabel", background="#f5f5f7", font=(".AppleSystemUIFont", 20, "bold"))
        self.style.configure("Muted.TLabel", background="#f5f5f7", foreground="#6e6e73")
        self.style.configure("Treeview", rowheight=28, font=(".AppleSystemUIFont", 12))
        self.style.configure("Treeview.Heading", font=(".AppleSystemUIFont", 12, "bold"))

    def _build_layout(self) -> None:
        root_frame = ttk.Frame(self.root, padding=(22, 18, 22, 18), style="Root.TFrame")
        root_frame.pack(fill=tk.BOTH, expand=True)
        root_frame.columnconfigure(0, weight=1)
        root_frame.rowconfigure(3, weight=1)

        title_row = ttk.Frame(root_frame, style="Panel.TFrame")
        title_row.grid(row=0, column=0, sticky="ew", pady=(0, 16))
        title_row.columnconfigure(0, weight=1)
        ttk.Label(title_row, text=APP_TITLE, style="Title.TLabel").grid(row=0, column=0, sticky="w")
        self.start_button = ttk.Button(title_row, text="开始测速", command=self.start_test)
        self.start_button.grid(row=0, column=1, sticky="e")

        file_row = ttk.Frame(root_frame, style="Panel.TFrame")
        file_row.grid(row=1, column=0, sticky="ew", pady=(0, 12))
        file_row.columnconfigure(1, weight=1)
        ttk.Label(file_row, text="代理列表", style="Muted.TLabel").grid(row=0, column=0, sticky="w", padx=(0, 10))
        ttk.Entry(file_row, textvariable=self.file_var).grid(row=0, column=1, sticky="ew", padx=(0, 8))
        ttk.Button(file_row, text="选择文件", command=self.choose_file).grid(row=0, column=2, sticky="e")

        options = ttk.Frame(root_frame, style="Panel.TFrame")
        options.grid(row=2, column=0, sticky="ew", pady=(0, 14))
        for index in range(8):
            options.columnconfigure(index, weight=1 if index in {1, 3, 5, 7} else 0)

        ttk.Label(options, text="并发数", style="Muted.TLabel").grid(row=0, column=0, sticky="w", padx=(0, 8))
        ttk.Entry(options, textvariable=self.workers_var, width=8).grid(row=0, column=1, sticky="w", padx=(0, 18))
        ttk.Label(options, text="下载大小", style="Muted.TLabel").grid(row=0, column=2, sticky="w", padx=(0, 8))
        ttk.Entry(options, textvariable=self.bytes_var, width=10).grid(row=0, column=3, sticky="w", padx=(0, 18))
        ttk.Label(options, text="连接超时", style="Muted.TLabel").grid(row=0, column=4, sticky="w", padx=(0, 8))
        ttk.Entry(options, textvariable=self.connect_timeout_var, width=8).grid(row=0, column=5, sticky="w", padx=(0, 18))
        ttk.Label(options, text="读取超时", style="Muted.TLabel").grid(row=0, column=6, sticky="w", padx=(0, 8))
        ttk.Entry(options, textvariable=self.read_timeout_var, width=8).grid(row=0, column=7, sticky="w")

        ttk.Label(options, text="测速地址", style="Muted.TLabel").grid(row=1, column=0, sticky="w", pady=(12, 0), padx=(0, 8))
        ttk.Entry(options, textvariable=self.url_var).grid(
            row=1,
            column=1,
            columnspan=5,
            sticky="ew",
            pady=(12, 0),
            padx=(0, 18),
        )
        ttk.Checkbutton(options, text="跳过代理证书校验", variable=self.insecure_proxy_var).grid(
            row=1,
            column=6,
            sticky="w",
            pady=(12, 0),
            padx=(0, 12),
        )
        ttk.Checkbutton(options, text="跳过目标证书校验", variable=self.insecure_target_var).grid(
            row=1,
            column=7,
            sticky="w",
            pady=(12, 0),
        )

        table_frame = ttk.Frame(root_frame)
        table_frame.grid(row=3, column=0, sticky="nsew")
        table_frame.columnconfigure(0, weight=1)
        table_frame.rowconfigure(0, weight=1)

        columns = ("rank", "name", "status", "speed", "ttfb", "total", "bytes", "proxy", "error")
        self.tree = ttk.Treeview(table_frame, columns=columns, show="headings", selectmode="browse")
        headings = {
            "rank": "#",
            "name": "节点",
            "status": "状态",
            "speed": "速度 Mbps",
            "ttfb": "TTFB ms",
            "total": "总耗时 ms",
            "bytes": "读取",
            "proxy": "代理",
            "error": "错误",
        }
        widths = {
            "rank": 50,
            "name": 150,
            "status": 100,
            "speed": 100,
            "ttfb": 90,
            "total": 100,
            "bytes": 80,
            "proxy": 260,
            "error": 260,
        }
        for column in columns:
            self.tree.heading(column, text=headings[column])
            self.tree.column(column, width=widths[column], minwidth=50, anchor=tk.W)
        self.tree.tag_configure("ok", foreground="#137333")
        self.tree.tag_configure("fail", foreground="#a50e0e")
        self.tree.grid(row=0, column=0, sticky="nsew")

        scroll_y = ttk.Scrollbar(table_frame, orient=tk.VERTICAL, command=self.tree.yview)
        scroll_y.grid(row=0, column=1, sticky="ns")
        self.tree.configure(yscrollcommand=scroll_y.set)

        bottom = ttk.Frame(root_frame, style="Panel.TFrame")
        bottom.grid(row=4, column=0, sticky="ew", pady=(12, 0))
        bottom.columnconfigure(0, weight=1)
        self.progress = ttk.Progressbar(bottom, mode="determinate")
        self.progress.grid(row=0, column=0, sticky="ew", padx=(0, 14))
        ttk.Label(bottom, textvariable=self.status_var, style="Status.TLabel").grid(row=0, column=1, sticky="e")

    def choose_file(self) -> None:
        path = filedialog.askopenfilename(
            title="选择代理列表",
            filetypes=(("Text files", "*.txt"), ("All files", "*.*")),
        )
        if path:
            self.file_var.set(path)
            self._preview_file(path)

    def _preview_file(self, path: str) -> None:
        try:
            nodes, errors = load_proxy_file(path)
        except OSError as exc:
            self.status_var.set(f"文件读取失败：{exc}")
            return
        if errors:
            self.status_var.set(f"已读取 {len(nodes)} 个节点，{len(errors)} 行格式错误")
        else:
            self.status_var.set(f"已读取 {len(nodes)} 个节点")

    def start_test(self) -> None:
        if self.running:
            return
        try:
            settings = self._read_settings()
        except ValueError as exc:
            messagebox.showerror(APP_TITLE, str(exc))
            return

        self.results = []
        self.completed_nodes = 0
        self.total_nodes = len(settings["nodes"])
        self.run_token += 1
        token = self.run_token
        self._clear_table()
        self.progress.configure(value=0, maximum=self.total_nodes)
        self.status_var.set(f"测速中：0/{self.total_nodes}")
        self.running = True
        self.start_button.configure(state=tk.DISABLED)

        thread = threading.Thread(target=self._run_tests, args=(token, settings), daemon=True)
        thread.start()

    def _read_settings(self) -> dict[str, object]:
        path = self.file_var.get().strip()
        if not path:
            raise ValueError("请选择代理列表文件。")
        if not os.path.exists(path):
            raise ValueError("代理列表文件不存在。")

        nodes, errors = load_proxy_file(path)
        if not nodes:
            raise ValueError("代理列表中没有有效节点。")
        if errors:
            messagebox.showwarning(APP_TITLE, "\n".join(errors[:5]))

        try:
            workers = int(self.workers_var.get().strip())
        except ValueError as exc:
            raise ValueError("并发数必须是整数。") from exc
        if workers <= 0:
            raise ValueError("并发数必须大于 0。")

        try:
            max_bytes = parse_size(self.bytes_var.get().strip())
        except Exception as exc:
            raise ValueError("下载大小格式无效，例如 64k、256k、1m。") from exc

        try:
            connect_timeout = float(self.connect_timeout_var.get().strip())
            read_timeout = float(self.read_timeout_var.get().strip())
        except ValueError as exc:
            raise ValueError("超时时间必须是数字。") from exc
        if connect_timeout <= 0 or read_timeout <= 0:
            raise ValueError("超时时间必须大于 0。")

        try:
            target = parse_target_url(self.url_var.get().strip())
        except ValueError as exc:
            raise ValueError(str(exc)) from exc

        return {
            "nodes": nodes,
            "target": target,
            "workers": min(workers, len(nodes)),
            "max_bytes": max_bytes,
            "connect_timeout": connect_timeout,
            "read_timeout": read_timeout,
            "target_ssl_context": make_ssl_context(self.insecure_target_var.get()),
            "proxy_ssl_context": make_ssl_context(self.insecure_proxy_var.get()),
        }

    def _run_tests(self, token: int, settings: dict[str, object]) -> None:
        nodes = settings["nodes"]
        workers = settings["workers"]
        with ThreadPoolExecutor(max_workers=workers) as executor:
            future_map = {
                executor.submit(
                    test_proxy,
                    node,
                    settings["target"],
                    settings["max_bytes"],
                    settings["connect_timeout"],
                    settings["read_timeout"],
                    settings["target_ssl_context"],
                    settings["proxy_ssl_context"],
                ): node
                for node in nodes
            }
            for future in as_completed(future_map):
                self.events.put(("result", token, future.result()))
        self.events.put(("done", token))

    def _poll_events(self) -> None:
        try:
            while True:
                event = self.events.get_nowait()
                kind = event[0]
                token = event[1]
                if token != self.run_token:
                    continue
                if kind == "result":
                    self._add_result(event[2])
                elif kind == "done":
                    self._finish_run()
        except queue.Empty:
            pass
        self.root.after(100, self._poll_events)

    def _add_result(self, result: TestResult) -> None:
        self.results.append(result)
        self.completed_nodes += 1
        self.progress.configure(value=self.completed_nodes)
        ok_count = sum(1 for item in self.results if item.ok)
        self.status_var.set(f"测速中：{self.completed_nodes}/{self.total_nodes}，可用 {ok_count}")
        self._render_results()

    def _finish_run(self) -> None:
        self.running = False
        self.start_button.configure(state=tk.NORMAL)
        ok_count = sum(1 for item in self.results if item.ok)
        self.status_var.set(f"完成：{self.total_nodes} 个节点，可用 {ok_count}")
        self._render_results()

    def _clear_table(self) -> None:
        for item in self.tree.get_children():
            self.tree.delete(item)

    def _render_results(self) -> None:
        self._clear_table()
        for rank, result in enumerate(sorted_results(self.results), 1):
            self.tree.insert(
                "",
                tk.END,
                values=(
                    rank,
                    result.name,
                    result.status,
                    self._format_mbps(result.speed_mbps),
                    self._format_ms(result.ttfb_ms),
                    self._format_ms(result.total_ms),
                    result.bytes_read or "-",
                    result.proxy,
                    result.error,
                ),
                tags=("ok" if result.ok else "fail",),
            )

    @staticmethod
    def _format_ms(value: Optional[float]) -> str:
        return "-" if value is None else f"{value:.0f}"

    @staticmethod
    def _format_mbps(value: float) -> str:
        return "-" if value <= 0 else f"{value:.2f}"


def gui_main() -> int:
    root = tk.Tk()
    ProxySpeedApp(root)
    root.mainloop()
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Batch speed test HTTP/HTTPS proxy nodes through an HTTPS target URL.",
    )
    parser.add_argument("proxy_file", help="proxy list file, one node per line")
    parser.add_argument(
        "--url",
        default=DEFAULT_TEST_URL,
        help=f"HTTPS URL used for testing, default: {DEFAULT_TEST_URL}",
    )
    parser.add_argument(
        "--bytes",
        dest="max_bytes",
        type=parse_size,
        default=DEFAULT_BYTES,
        help="maximum response body bytes to read per proxy, e.g. 128k, 1m; default: 256k",
    )
    parser.add_argument("--workers", type=int, default=32, help="concurrent tests, default: 32")
    parser.add_argument("--connect-timeout", type=float, default=5.0, help="TCP timeout seconds")
    parser.add_argument("--read-timeout", type=float, default=10.0, help="read/TLS timeout seconds")
    parser.add_argument("--top", type=int, default=None, help="only print the fastest N nodes")
    parser.add_argument("--csv", dest="csv_path", help="write full sorted result to CSV")
    parser.add_argument("--json", dest="json_path", help="write full sorted result to JSON")
    parser.add_argument("--insecure", action="store_true", help="disable TLS verification for target site")
    parser.add_argument(
        "--insecure-proxy",
        action="store_true",
        help="disable TLS verification for https:// proxy endpoints",
    )
    parser.add_argument("--quiet", action="store_true", help="hide progress output")
    return parser


def cli_main(argv: Optional[list[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.workers <= 0:
        parser.error("--workers must be > 0")

    try:
        target = parse_target_url(args.url)
    except ValueError as exc:
        parser.error(str(exc))

    nodes, parse_errors = load_proxy_file(args.proxy_file)
    for error in parse_errors:
        print(f"warning: {error}", file=sys.stderr)
    if not nodes:
        print("error: no valid proxy nodes found", file=sys.stderr)
        return 2

    if not args.quiet:
        print(
            f"Loaded {len(nodes)} proxies. Testing {target.url} "
            f"({args.max_bytes} bytes max each)...",
            file=sys.stderr,
        )

    target_ssl_context = make_ssl_context(args.insecure)
    proxy_ssl_context = make_ssl_context(args.insecure_proxy)
    results: list[TestResult] = []
    workers = min(args.workers, len(nodes))

    with ThreadPoolExecutor(max_workers=workers) as executor:
        future_map = {
            executor.submit(
                test_proxy,
                node,
                target,
                args.max_bytes,
                args.connect_timeout,
                args.read_timeout,
                target_ssl_context,
                proxy_ssl_context,
            ): node
            for node in nodes
        }
        for index, future in enumerate(as_completed(future_map), 1):
            results.append(future.result())
            if not args.quiet:
                print(f"\rTested {index}/{len(nodes)}", end="", file=sys.stderr, flush=True)
    if not args.quiet:
        print(file=sys.stderr)

    ordered = sorted_results(results)
    print(render_table(ordered, top=args.top))

    if args.csv_path:
        write_csv(args.csv_path, ordered)
        if not args.quiet:
            print(f"CSV written to {args.csv_path}", file=sys.stderr)
    if args.json_path:
        write_json(args.json_path, ordered)
        if not args.quiet:
            print(f"JSON written to {args.json_path}", file=sys.stderr)

    return 0 if any(result.ok for result in ordered) else 1


def main(argv: Optional[list[str]] = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if not args or args == ["--gui"]:
        return gui_main()
    if args and args[0] == "--gui":
        print("error: --gui cannot be combined with CLI arguments", file=sys.stderr)
        return 2
    return cli_main(args)


if __name__ == "__main__":
    raise SystemExit(main())
