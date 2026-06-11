import tkinter as tk
from tkinter import filedialog, messagebox, ttk
import os
from bs4 import BeautifulSoup
import re

class HTMLToMarkdownConverter:
    def __init__(self, root):
        self.root = root
        self.root.title("HTML转Markdown转换器")
        self.root.geometry("600x200")
        
        # 变量
        self.input_file = tk.StringVar()
        self.status_text = tk.StringVar(value="请选择HTML文件")
        
        self.setup_ui()
    
    def setup_ui(self):
        # 主框架
        main_frame = ttk.Frame(self.root, padding="20")
        main_frame.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        
        # 输入文件选择
        ttk.Label(main_frame, text="选择HTML文件:").grid(row=0, column=0, sticky=tk.W, pady=5)
        file_frame = ttk.Frame(main_frame)
        file_frame.grid(row=1, column=0, columnspan=2, sticky=(tk.W, tk.E), pady=5)
        
        ttk.Entry(file_frame, textvariable=self.input_file, width=50).grid(row=0, column=0, sticky=(tk.W, tk.E))
        ttk.Button(file_frame, text="浏览", command=self.browse_input_file).grid(row=0, column=1, padx=5)
        
        # 开始按钮
        ttk.Button(main_frame, text="开始转换", command=self.start_conversion).grid(row=2, column=0, pady=20)
        
        # 状态标签
        status_label = ttk.Label(main_frame, textvariable=self.status_text, font=("Arial", 10))
        status_label.grid(row=3, column=0, sticky=(tk.W, tk.E), pady=5)
        
        # 配置网格权重
        main_frame.columnconfigure(0, weight=1)
        file_frame.columnconfigure(0, weight=1)
    
    def browse_input_file(self):
        filename = filedialog.askopenfilename(
            title="选择HTML文件",
            filetypes=[("HTML文件", "*.html"), ("所有文件", "*.*")]
        )
        if filename:
            self.input_file.set(filename)
            self.status_text.set("已选择文件，点击'开始转换'按钮")
    
    def is_excluded_paragraph(self, text):
        """判断段落是否应该被排除"""
        # 排除包含"约"和"万字"的段落
        if re.search(r'约\s*\d+\.?\d*\s*万字', text):
            return True
        # 可以在这里添加其他排除规则
        return False
    
    def find_special_heading_paragraph(self, heading_element):
        """查找特殊标题后的第一个段落元素"""
        # 查找标题后面的所有兄弟元素
        next_elements = heading_element.find_next_siblings()
        
        for element in next_elements:
            # 如果遇到下一个标题，停止搜索
            if element.name and element.name.startswith('h') and element.name[1:].isdigit():
                break
                
            # 查找段落元素，特别是带有特定class的段落
            if element.name == 'p' or (element.get('class') and any('paragraph' in cls for cls in element.get('class'))):
                paragraph_text = element.get_text(strip=True)
                if paragraph_text and not self.is_excluded_paragraph(paragraph_text):
                    return paragraph_text
                    
            # 如果元素内部包含段落，也检查
            if element.find('p'):
                p_element = element.find('p')
                paragraph_text = p_element.get_text(strip=True)
                if paragraph_text and not self.is_excluded_paragraph(paragraph_text):
                    return paragraph_text
                    
            # 检查元素本身是否是段落（通过class判断）
            if element.get('class') and any('paragraph' in cls for cls in element.get('class')):
                paragraph_text = element.get_text(strip=True)
                if paragraph_text and not self.is_excluded_paragraph(paragraph_text):
                    return paragraph_text
        
        return None
    
    def process_element(self, element, indent_level=0):
        """递归处理HTML元素，转换为Markdown格式"""
        markdown_lines = []
        
        # 处理标题元素 (h1-h6)
        if element.name and element.name.startswith('h') and element.name[1:].isdigit():
            heading_text = element.get_text(strip=True)
            if heading_text:
                heading_level = int(element.name[1])
                # 检查是否包含"大框架"或"核心主线"
                if "大框架" in heading_text or "核心主线" in heading_text:
                    # 为特殊标题添加标记
                    markdown_line = "## " + heading_text
                    markdown_lines.append(markdown_line)
                    
                    # 查找并添加标题下方的第一个段落内容
                    paragraph_content = self.find_special_heading_paragraph(element)
                    if paragraph_content:
                        markdown_lines.append("")  # 添加空行
                        markdown_lines.append(paragraph_content)
                        markdown_lines.append("")  # 添加空行
                else:
                    # 其他标题保持原样
                    markdown_line = "#" * heading_level + " " + heading_text
                    markdown_lines.append(markdown_line)
        
        # 处理有序列表 (ol)
        elif element.name == 'ol':
            list_items = element.find_all('li', recursive=False)
            for i, li in enumerate(list_items, 1):
                li_text = li.get_text(strip=True)
                if li_text and not self.is_excluded_paragraph(li_text):
                    # 递归处理列表项内的内容
                    nested_content = []
                    for child in li.children:
                        if hasattr(child, 'name') and child.name:
                            nested_content.extend(self.process_element(child, indent_level + 1))
                    
                    # 构建列表项
                    indent = "  " * indent_level
                    list_item = f"{indent}{i}. {li_text}"
                    markdown_lines.append(list_item)
                    
                    # 添加嵌套内容
                    markdown_lines.extend(nested_content)
        
        # 处理无序列表 (ul)
        elif element.name == 'ul':
            list_items = element.find_all('li', recursive=False)
            for li in list_items:
                li_text = li.get_text(strip=True)
                if li_text and not self.is_excluded_paragraph(li_text):
                    # 递归处理列表项内的内容
                    nested_content = []
                    for child in li.children:
                        if hasattr(child, 'name') and child.name:
                            nested_content.extend(self.process_element(child, indent_level + 1))
                    
                    # 构建列表项
                    indent = "  " * indent_level
                    list_item = f"{indent}- {li_text}"
                    markdown_lines.append(list_item)
                    
                    # 添加嵌套内容
                    markdown_lines.extend(nested_content)
        
        # 处理段落元素 (p)
        elif element.name == 'p':
            paragraph_text = element.get_text(strip=True)
            if paragraph_text and not self.is_excluded_paragraph(paragraph_text):
                # 检查这个段落是否已经被特殊标题处理过
                prev_elements = element.find_all_previous()
                for prev in prev_elements:
                    if (prev.name and prev.name.startswith('h') and prev.name[1:].isdigit() and
                        ("大框架" in prev.get_text() or "核心主线" in prev.get_text())):
                        # 如果前面有特殊标题，并且这个段落是它的第一个段落，则跳过
                        first_paragraph = self.find_special_heading_paragraph(prev)
                        if first_paragraph == paragraph_text:
                            return []
                markdown_lines.append(paragraph_text)
        
        # 对于其他元素，递归处理其子元素
        elif hasattr(element, 'children'):
            for child in element.children:
                if hasattr(child, 'name') and child.name:
                    markdown_lines.extend(self.process_element(child, indent_level))
        
        return markdown_lines
    
    def extract_content_from_html(self, html_content):
        """从HTML中提取内容并转换为Markdown格式，保持嵌套结构"""
        soup = BeautifulSoup(html_content, 'html.parser')
        
        # 查找所有class="item-kDun2N"的元素
        items = soup.find_all(class_="item-kDun2N")
        
        markdown_lines = []
        framework_count = 0
        paragraph_count = 0
        
        for item in items:
            # 递归处理每个项目
            item_lines = self.process_element(item)
            markdown_lines.extend(item_lines)
            
            # 统计大框架数量和采集的段落数量
            for line in item_lines:
                if ("大框架" in line or "核心主线" in line) and line.startswith("##"):
                    framework_count += 1
                # 统计采集的特殊段落
                elif (line and not line.startswith('#') and not line.startswith('-') and 
                      not line.startswith((' ', '\t')) and line.strip()):
                    # 检查这个段落是否在特殊标题后面
                    if len(markdown_lines) >= 3:
                        prev_lines = markdown_lines[-3:]
                        for prev_line in reversed(prev_lines):
                            if prev_line.startswith("##") and ("大框架" in prev_line or "核心主线" in prev_line):
                                paragraph_count += 1
                                break
        
        return markdown_lines, framework_count, paragraph_count
    
    def start_conversion(self):
        # 验证输入
        if not self.input_file.get():
            messagebox.showerror("错误", "请选择输入文件")
            return
        
        # 开始转换
        self.status_text.set("🚧处理中...")
        self.root.update()  # 强制更新界面显示状态
        
        try:
            # 读取HTML文件
            with open(self.input_file.get(), 'r', encoding='utf-8') as file:
                html_content = file.read()
            
            # 提取内容并转换为Markdown
            markdown_lines, framework_count, paragraph_count = self.extract_content_from_html(html_content)
            
            # 生成输出文件名 - 与输入文件在同一目录
            input_file_path = self.input_file.get()
            input_dir = os.path.dirname(input_file_path)
            input_filename = os.path.basename(input_file_path)
            output_filename = os.path.splitext(input_filename)[0] + ".md"
            output_path = os.path.join(input_dir, output_filename)
            
            # 写入Markdown文件
            with open(output_path, 'w', encoding='utf-8') as file:
                for line in markdown_lines:
                    file.write(line + '\n')
                    # 在标题后添加空行
                    if line.startswith('#'):
                        file.write('\n')
            
            self.status_text.set("🥳已完成")
            
            messagebox.showinfo("完成", 
                              f"转换完成！\n"
                              f"共处理 {len(markdown_lines)} 个内容项\n"
                              f"其中包含 {framework_count} 个特殊标题\n"
                              f"采集了 {paragraph_count} 个特殊段落\n"
                              f"输出文件: {output_path}")
            
        except Exception as e:
            self.status_text.set("转换失败")
            messagebox.showerror("错误", f"转换失败: {str(e)}")

def main():
    root = tk.Tk()
    app = HTMLToMarkdownConverter(root)
    root.mainloop()

if __name__ == "__main__":
    main()
