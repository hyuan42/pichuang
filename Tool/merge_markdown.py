#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
合并 Markdown 文件工具
------------------------
提供一个简单的 GUI：用户选择一个本地文件夹，
脚本会把该文件夹内（不含子文件夹）所有 .md / .markdown 文件
按文件的添加（创建）日期从早到晚排序合并成一个文件，输出到该文件夹内，命名为 done.md。
"""

import os
import glob
import tkinter as tk
from tkinter import filedialog, messagebox


def get_creation_time(file_path: str) -> float:
    """获取文件的创建（添加）时间。macOS 上优先使用 st_birthtime，
    不支持时回退到 st_ctime。"""
    stat = os.stat(file_path)
    return getattr(stat, "st_birthtime", stat.st_ctime)


def merge_markdown_files(folder: str) -> str:
    """合并 folder 内所有 markdown 文件，按添加日期从早到晚排序，返回生成的输出文件路径。"""
    md_files = (
        glob.glob(os.path.join(folder, "*.md"))
        + glob.glob(os.path.join(folder, "*.markdown"))
    )
    md_files = sorted(md_files, key=get_creation_time)

    output_path = os.path.join(folder, "done.md")

    # 避免把上一次生成的 done.md 也合并进去
    md_files = [f for f in md_files if os.path.abspath(f) != os.path.abspath(output_path)]

    if not md_files:
        raise ValueError("所选文件夹中没有找到 Markdown 文件（.md / .markdown）。")

    with open(output_path, "w", encoding="utf-8") as out_f:
        for i, file_path in enumerate(md_files):
            file_name = os.path.basename(file_path)
            with open(file_path, "r", encoding="utf-8", errors="ignore") as in_f:
                content = in_f.read()

            # 用标题标注每个文件的来源，便于区分
            out_f.write(f"# {file_name}\n\n")
            out_f.write(content.rstrip())
            out_f.write("\n\n")

            if i != len(md_files) - 1:
                out_f.write("---\n\n")

    return output_path


class App:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.root.title("Markdown 合并工具")
        self.root.geometry("480x220")
        self.root.resizable(False, False)

        self.folder_var = tk.StringVar(value="尚未选择文件夹")

        tk.Label(root, text="Markdown 文件合并工具", font=("PingFang SC", 16, "bold")).pack(pady=15)

        tk.Label(root, textvariable=self.folder_var, wraplength=440, fg="#555").pack(pady=5)

        tk.Button(root, text="选择文件夹...", command=self.choose_folder, width=20, height=2).pack(pady=10)

        self.status_var = tk.StringVar(value="")
        tk.Label(root, textvariable=self.status_var, fg="green").pack(pady=5)

    def choose_folder(self):
        folder = filedialog.askdirectory(title="请选择包含 Markdown 文件的文件夹")
        if not folder:
            return

        self.folder_var.set(folder)
        self.status_var.set("正在合并...")
        self.root.update_idletasks()

        try:
            output_path = merge_markdown_files(folder)
        except Exception as e:
            self.status_var.set("")
            messagebox.showerror("出错了", str(e))
            return

        self.status_var.set(f"完成！已生成：{output_path}")
        messagebox.showinfo("完成", f"合并完成，文件已保存至：\n{output_path}")


def main():
    root = tk.Tk()
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
