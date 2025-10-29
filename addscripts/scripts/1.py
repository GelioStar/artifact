import os
import tkinter as tk
from tkinter import filedialog

def get_directory():
    root = tk.Tk()
    root.withdraw()  # Скрываем основное окно
    folder_selected = filedialog.askdirectory()  # Открываем диалог выбора папки
    return folder_selected

def process_filenames(folder_path):
    mp4_files = [f for f in os.listdir(folder_path) if f.lower().endswith('.mp4')]
    results = []
    
    for filename in mp4_files:
        # Удаляем расширение .mp4
        name_without_ext = os.path.splitext(filename)[0]
        
        # Разделяем по " - " чтобы отделить дату и название
        parts = name_without_ext.split(' - ', 1)
        
        # Если есть часть после " - ", берем ее, иначе оставляем пустую строку
        title = parts[1] if len(parts) > 1 else ''
        
        # Удаляем возможные пробелы в начале и конце
        title = title.strip()
        
        if title:  # Добавляем только если есть название
            results.append(title)
    
    return results

def save_to_txt(output_path, titles):
    with open(output_path, 'w', encoding='utf-8') as f:
        for title in titles:
            f.write(title + '\n')

def main():
    folder_path = get_directory()
    if not folder_path:  # Если папка не выбрана
        print("Папка не выбрана. Скрипт завершен.")
        return
    
    titles = process_filenames(folder_path)
    
    if not titles:
        print("Нет .mp4 файлов с названиями для обработки.")
        return
    
    # Сохраняем в той же папке, где запущен скрипт
    output_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'output.txt')
    save_to_txt(output_path, titles)
    print(f"Результат сохранен в: {output_path}")

if __name__ == "__main__":
    main()