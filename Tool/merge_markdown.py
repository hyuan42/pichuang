#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
合并 Markdown 文件工具
------------------------
提供一个 macOS 风格的 GUI：用户在路径框中选择（或输入）一个本地文件夹，
点击"合并"后，脚本会把该文件夹内所有 .md / .markdown 文件按文件的
添加（创建）日期从早到晚排序合并成一个文件，输出到该文件夹内，
命名为 "<文件夹名>_合并.md"。

另外提供两个可选开关：
1. "包含子文件夹"：勾选后会把子文件夹里的 md 文件也一起纳入合并范围。
   合并顺序为：先合并根目录里的文件（按添加日期从早到晚），
   再按子文件夹本身的创建日期从早到晚排序，依次合并每个子文件夹内的文件
   （子文件夹内部同样按添加日期从早到晚排序），全部写入同一个输出文件。
2. "每个子文件夹单独一个文件"：勾选后，根目录下的文件仍单独合并，
   但每个子文件夹会各自合并成一个文件（命名为 "<子文件夹名>_合并.md"），
   并统一放入根目录下新建的 "合并文件" 文件夹中。勾选此项时会自动按
   子文件夹处理，无需额外勾选选项 1。
"""

import os
import glob
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

MERGED_FOLDER_NAME = "合并文件"


def merged_file_name(folder_path: str) -> str:
    """根据文件夹名生成合并输出文件名，格式为 "<文件夹名>_合并.md"。"""
    name = os.path.basename(os.path.normpath(folder_path))
    return f"{name}_合并.md"


def get_creation_time(path: str) -> float:
    """获取文件/文件夹的创建（添加）时间。macOS 上优先使用 st_birthtime，
    不支持时回退到 st_ctime。"""
    stat = os.stat(path)
    return getattr(stat, "st_birthtime", stat.st_ctime)


def list_md_files_sorted(folder: str, exclude_paths=None) -> list:
    """列出 folder 内（不含子文件夹）所有 md 文件，按创建日期从早到晚排序。"""
    exclude_paths = {os.path.abspath(p) for p in (exclude_paths or [])}
    md_files = (
        glob.glob(os.path.join(folder, "*.md"))
        + glob.glob(os.path.join(folder, "*.markdown"))
    )
    md_files = [f for f in md_files if os.path.abspath(f) not in exclude_paths]
    return sorted(md_files, key=get_creation_time)


def list_subfolders_sorted(folder: str, exclude_names=None) -> list:
    """列出 folder 内一级子文件夹，按创建日期从早到晚排序，排除隐藏文件夹。"""
    exclude_names = exclude_names or set()
    subfolders = [
        entry.path
        for entry in os.scandir(folder)
        if entry.is_dir()
        and not entry.name.startswith(".")
        and entry.name not in exclude_names
    ]
    return sorted(subfolders, key=get_creation_time)


def write_merged_file(md_files: list, output_path: str) -> None:
    """把 md_files 按顺序合并写入 output_path。"""
    with open(output_path, "w", encoding="utf-8") as out_f:
        for i, file_path in enumerate(md_files):
            file_name = os.path.basename(file_path)
            with open(file_path, "r", encoding="utf-8", errors="ignore") as in_f:
                content = in_f.read()

            out_f.write(f"# {file_name}\n\n")
            out_f.write(content.rstrip())
            out_f.write("\n\n")

            if i != len(md_files) - 1:
                out_f.write("---\n\n")


def merge_markdown_files(folder: str, include_subfolders: bool, separate_per_subfolder: bool) -> str:
    """根据选项合并 folder 内的 markdown 文件，返回给用户展示的结果说明文本。"""
    output_path = os.path.join(folder, merged_file_name(folder))
    merged_folder = os.path.join(folder, MERGED_FOLDER_NAME)

    if separate_per_subfolder:
        return _merge_per_subfolder(folder, output_path, merged_folder)

    if include_subfolders:
        return _merge_all_recursive(folder, output_path, merged_folder)

    return _merge_root_only(folder, output_path)


def _merge_root_only(folder: str, output_path: str) -> str:
    root_files = list_md_files_sorted(folder, exclude_paths=[output_path])
    if not root_files:
        raise ValueError("所选文件夹中没有找到 Markdown 文件（.md / .markdown）。")
    write_merged_file(root_files, output_path)
    return f"合并完成，文件已保存至：\n{output_path}"


def _merge_all_recursive(folder: str, output_path: str, merged_folder: str) -> str:
    all_files = list_md_files_sorted(folder, exclude_paths=[output_path])

    subfolders = list_subfolders_sorted(folder, exclude_names={MERGED_FOLDER_NAME})
    for sub in subfolders:
        all_files.extend(list_md_files_sorted(sub))

    if not all_files:
        raise ValueError("所选文件夹（含子文件夹）中没有找到 Markdown 文件（.md / .markdown）。")

    write_merged_file(all_files, output_path)
    return f"合并完成，文件已保存至：\n{output_path}"


def _merge_per_subfolder(folder: str, output_path: str, merged_folder: str) -> str:
    created_files = []

    # 1. 根目录文件单独合并
    root_files = list_md_files_sorted(folder, exclude_paths=[output_path])
    if root_files:
        write_merged_file(root_files, output_path)
        created_files.append(output_path)

    # 2. 每个子文件夹单独合并，并放入 "合并文件" 文件夹
    subfolders = list_subfolders_sorted(folder, exclude_names={MERGED_FOLDER_NAME})
    subfolder_outputs = []
    for sub in subfolders:
        sub_files = list_md_files_sorted(sub)
        if not sub_files:
            continue
        target_path = os.path.join(merged_folder, merged_file_name(sub))
        subfolder_outputs.append((sub_files, target_path))

    if not created_files and not subfolder_outputs:
        raise ValueError("所选文件夹（含子文件夹）中没有找到 Markdown 文件（.md / .markdown）。")

    if subfolder_outputs:
        os.makedirs(merged_folder, exist_ok=True)
        for sub_files, target_path in subfolder_outputs:
            write_merged_file(sub_files, target_path)
            created_files.append(target_path)

    file_list = "\n".join(f"- {p}" for p in created_files)
    return f"合并完成，共生成 {len(created_files)} 个文件：\n{file_list}"


# ---------------------------------------------------------------------------
# macOS 风格 GUI
# ---------------------------------------------------------------------------

BG_COLOR = "#ECECEC"          # 窗口背景（浅灰，接近 macOS 系统背景）
CARD_COLOR = "#FFFFFF"        # 卡片背景
TEXT_PRIMARY = "#1D1D1F"      # 主文字颜色（苹果深灰黑）
TEXT_SECONDARY = "#6E6E73"    # 次要文字颜色
ACCENT_COLOR = "#0071E3"      # 苹果经典蓝
BORDER_COLOR = "#D2D2D7"

FONT_FAMILY = "PingFang SC"


class App:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.root.title("Markdown 合并工具")
        self.root.geometry("560x420")
        self.root.minsize(560, 420)
        self.root.configure(bg=BG_COLOR)

        self.path_var = tk.StringVar(value="")
        self.include_subfolders_var = tk.BooleanVar(value=False)
        self.separate_per_subfolder_var = tk.BooleanVar(value=False)
        self.status_var = tk.StringVar(value="")

        self._setup_style()
        self._build_ui()

    # -- 样式 -----------------------------------------------------------
    def _setup_style(self):
        style = ttk.Style(self.root)
        # 优先使用系统原生 aqua 主题，取不到则退回 clam 并手动上色
        available = style.theme_names()
        if "aqua" in available:
            style.theme_use("aqua")
        else:
            style.theme_use("clam")

        style.configure("TFrame", background=CARD_COLOR)
        style.configure("Root.TFrame", background=BG_COLOR)
        style.configure(
            "Title.TLabel",
            background=BG_COLOR,
            foreground=TEXT_PRIMARY,
            font=(FONT_FAMILY, 20, "bold"),
        )
        style.configure(
            "Subtitle.TLabel",
            background=BG_COLOR,
            foreground=TEXT_SECONDARY,
            font=(FONT_FAMILY, 12),
        )
        style.configure(
            "Section.TLabel",
            background=CARD_COLOR,
            foreground=TEXT_PRIMARY,
            font=(FONT_FAMILY, 12, "bold"),
        )
        style.configure(
            "Card.TLabelframe",
            background=CARD_COLOR,
            bordercolor=BORDER_COLOR,
            relief="solid",
            borderwidth=1,
        )
        style.configure(
            "Card.TLabelframe.Label",
            background=CARD_COLOR,
            foreground=TEXT_PRIMARY,
            font=(FONT_FAMILY, 12, "bold"),
        )
        style.configure(
            "Option.TCheckbutton",
            background=CARD_COLOR,
            foreground=TEXT_PRIMARY,
            font=(FONT_FAMILY, 12),
        )
        style.configure(
            "Status.TLabel",
            background=BG_COLOR,
            foreground=TEXT_SECONDARY,
            font=(FONT_FAMILY, 11),
        )
        style.configure(
            "Path.TEntry",
            fieldbackground=CARD_COLOR,
            padding=6,
        )
        style.configure(
            "Accent.TButton",
            font=(FONT_FAMILY, 12, "bold"),
        )

    # -- 布局 -----------------------------------------------------------
    def _build_ui(self):
        container = ttk.Frame(self.root, style="Root.TFrame", padding=24)
        container.pack(fill="both", expand=True)

        # 标题区
        ttk.Label(container, text="Markdown 合并工具", style="Title.TLabel").pack(
            anchor="w"
        )
        ttk.Label(
            container,
            text="选择一个文件夹，将其中的 Markdown 文件按添加日期合并为一个文件",
            style="Subtitle.TLabel",
        ).pack(anchor="w", pady=(4, 20))

        # 路径选择卡片
        path_card = ttk.Frame(
            container, style="TFrame", padding=16, relief="solid", borderwidth=1
        )
        path_card.pack(fill="x", pady=(0, 16))
        path_card.configure(style="TFrame")

        ttk.Label(path_card, text="文件夹路径", style="Section.TLabel").pack(
            anchor="w", pady=(0, 8)
        )

        path_row = ttk.Frame(path_card, style="TFrame")
        path_row.pack(fill="x")

        self.path_entry = ttk.Entry(
            path_row, textvariable=self.path_var, style="Path.TEntry"
        )
        self.path_entry.pack(side="left", fill="x", expand=True, ipady=3)

        ttk.Button(path_row, text="浏览…", command=self.browse_folder).pack(
            side="left", padx=(8, 0)
        )

        # 选项卡片
        options_card = ttk.LabelFrame(
            container, text="合并选项", style="Card.TLabelframe", padding=16
        )
        options_card.pack(fill="x", pady=(0, 20))

        ttk.Checkbutton(
            options_card,
            text="包含子文件夹",
            variable=self.include_subfolders_var,
            style="Option.TCheckbutton",
        ).pack(anchor="w", pady=(0, 6))

        ttk.Checkbutton(
            options_card,
            text="每个子文件夹单独一个文件",
            variable=self.separate_per_subfolder_var,
            style="Option.TCheckbutton",
        ).pack(anchor="w")

        # 操作按钮
        action_row = ttk.Frame(container, style="Root.TFrame")
        action_row.pack(fill="x", pady=(0, 16))

        self.merge_button = ttk.Button(
            action_row,
            text="开始合并",
            command=self.run_merge,
            style="Accent.TButton",
        )
        self.merge_button.pack(side="left")
        # 在 macOS aqua 主题下，标记为默认按钮会呈现原生蓝色高亮
        try:
            self.merge_button.state(["default"])
        except tk.TclError:
            pass
        self.root.bind("<Return>", lambda _event: self.run_merge())

        # 状态展示
        status_card = ttk.Frame(
            container, style="TFrame", padding=16, relief="solid", borderwidth=1
        )
        status_card.pack(fill="both", expand=True)

        self.status_label = ttk.Label(
            status_card,
            textvariable=self.status_var,
            style="Status.TLabel",
            wraplength=480,
            justify="left",
            anchor="nw",
        )
        self.status_label.configure(background=CARD_COLOR)
        self.status_label.pack(fill="both", expand=True)

    # -- 事件处理 ---------------------------------------------------------
    def browse_folder(self):
        initial = self.path_var.get() or None
        folder = filedialog.askdirectory(
            title="请选择包含 Markdown 文件的文件夹", initialdir=initial
        )
        if folder:
            self.path_var.set(folder)

    def run_merge(self):
        folder = self.path_var.get().strip()

        if not folder:
            messagebox.showwarning("提示", "请先选择或输入一个文件夹路径。")
            return

        if not os.path.isdir(folder):
            messagebox.showerror("出错了", f"路径不存在或不是文件夹：\n{folder}")
            return

        self.status_var.set("正在合并…")
        self.status_label.configure(foreground=TEXT_SECONDARY)
        self.root.update_idletasks()

        try:
            result_text = merge_markdown_files(
                folder,
                include_subfolders=self.include_subfolders_var.get(),
                separate_per_subfolder=self.separate_per_subfolder_var.get(),
            )
        except Exception as e:
            self.status_var.set("")
            messagebox.showerror("出错了", str(e))
            return

        self.status_label.configure(foreground="#1B873F")
        self.status_var.set(result_text)
        messagebox.showinfo("完成", result_text)


def main():
    root = tk.Tk()
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
