import re
import os
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

def validate_chapters_input(P):
    """验证输入是否为1-1000之间的数字"""
    if P == "":
        return True
    if P.isdigit():
        num = int(P)
        return 1 <= num <= 1000
    return False

def split_novel(input_file, chapters_per_file):
    # 获取输入文件的目录和文件名（不含扩展名）
    file_dir = os.path.dirname(input_file)
    file_name = os.path.basename(input_file)
    file_name_without_ext = os.path.splitext(file_name)[0]
    
    # 在输入文件同目录下创建同名文件夹作为输出目录
    output_dir = os.path.join(file_dir, file_name_without_ext)
    if not os.path.exists(output_dir):
        os.makedirs(output_dir)

    with open(input_file, 'r', encoding='utf-8') as file:
        content = file.read()

    # 只能识别第x章这种格式
    chapter_pattern = r'^第\s*(\d+|[\u4e00-\u9fa5零一二三四五六七八九十百千万]+)\s*章\s*[:：、.]?\s*(.*)$'

    # 按行分割内容
    lines = content.split('\n')
    chapter_contents = []
    current_chapter = []
    
    # 逐行扫描，识别章节
    for line in lines:
        if re.match(chapter_pattern, line.strip()):
            # 如果是新章节，保存前一章内容并开始新章节
            if current_chapter:
                chapter_contents.append('\n'.join(current_chapter))
                current_chapter = []
        current_chapter.append(line)
    
    # 添加最后一章
    if current_chapter:
        chapter_contents.append('\n'.join(current_chapter))
    
    # 按照指定章节数进行分割
    for i in range(0, len(chapter_contents), chapters_per_file):
        end = min(i + chapters_per_file, len(chapter_contents))
        filename = f"{output_dir}/{file_name_without_ext}_{i // chapters_per_file + 1}.txt"
        with open(filename, 'w', encoding='utf-8') as output_file:
            output_file.write('\n\n'.join(chapter_contents[i:end]))
            
    # 执行成功后，弹出提示
    messagebox.showinfo("提示", f"执行成功！共分割出 {len(chapter_contents)} 个章节，生成 {((len(chapter_contents)-1)//chapters_per_file)+1} 个文件。\n输出目录：{output_dir}")

def browse_input_file():
    filename = filedialog.askopenfilename(filetypes=[("文本文件", "*.txt"), ("所有文件", "*.*")])
    if filename:
        input_file_entry.delete(0, tk.END)
        input_file_entry.insert(tk.END, filename)

def start_split():
    input_file = input_file_entry.get()
    
    # 从输入框获取章节数
    chapters_text = chapters_per_file_entry.get()
    if not chapters_text.isdigit():
        messagebox.showerror("错误", "请输入有效的章节数（1-1000）")
        return
        
    chapters_per_file = int(chapters_text)
    
    if not input_file:
        messagebox.showerror("错误", "请选择输入文件")
    elif not input_file.lower().endswith('.txt'):
        messagebox.showerror("错误", "输入文件必须是.txt格式")
    elif not chapters_per_file or chapters_per_file < 1 or chapters_per_file > 1000:
        messagebox.showerror("错误", "章节数必须在1到1000之间")
    else:
        split_novel(input_file, chapters_per_file)

# 创建主窗口
root = tk.Tk()
root.title("txt小说分割器")
root.geometry("320x200")
root.resizable(False, False)

# 使用ttk样式
style = ttk.Style()

# 尝试设置现代化主题
for theme in ['aqua', 'clam', 'alt', 'default']:
    try:
        style.theme_use(theme)
        break
    except:
        continue

# 配置ttk样式
style.configure('TFrame', background='#f5f5f5')
style.configure('TLabel', background='#f5f5f5')
style.configure('TButton', background='#4285f4', foreground='white', focuscolor='none')
style.map('TButton', background=[('active', '#3367d6')])
style.configure('TEntry', fieldbackground='white', foreground='#999999')

# 主容器
main_frame = ttk.Frame(root, padding="20")
main_frame.pack(fill=tk.BOTH, expand=True)

# 输入文件部分
input_file_label = ttk.Label(main_frame, text="选择txt小说文件:")
input_file_label.grid(row=0, column=0, sticky="w", pady=(0, 5))

input_file_entry = ttk.Entry(main_frame, width=40)
input_file_entry.grid(row=1, column=0, sticky="we", pady=(0, 10))

input_file_button = ttk.Button(main_frame, text="浏览...", command=browse_input_file)
input_file_button.grid(row=1, column=1, padx=(5, 0), pady=(0, 10))

# 章节数设置部分
chapters_per_file_label = ttk.Label(main_frame, text="每个文件章节数:")
chapters_per_file_label.grid(row=2, column=0, sticky="w", pady=(0, 5))

# 注册验证命令
vcmd = (root.register(validate_chapters_input), '%P')

chapters_per_file_entry = ttk.Entry(main_frame, width=10, justify='center', validate="key", validatecommand=vcmd)
chapters_per_file_entry.grid(row=3, column=0, sticky="w", pady=(0, 20))
chapters_per_file_entry.insert(0, "30")  # 默认值设为30

# 开始按钮
start_button = ttk.Button(main_frame, text="开始分割", command=start_split)
start_button.grid(row=4, column=0, columnspan=2, pady=10)

# 配置列权重，使输入框可以扩展
main_frame.columnconfigure(0, weight=1)

root.mainloop()
