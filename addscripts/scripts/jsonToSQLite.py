import json
import sqlite3
import os
import tkinter as tk
from tkinter import filedialog

def main():
    # Настройка графического интерфейса для выбора файла
    root = tk.Tk()
    root.withdraw()  # Скрываем основное окно
    
    # Выбираем JSON-файл через проводник
    json_file_path = filedialog.askopenfilename(
        title="Выберите JSON файл",
        filetypes=[("JSON files", "*.json")]
    )
    
    if not json_file_path:
        print("Файл не выбран. Скрипт завершен.")
        return

    # Загружаем данные из JSON
    with open(json_file_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    # Определяем путь для базы данных (рядом со скриптом)
    script_dir = os.path.dirname(os.path.abspath(__file__))
    db_path = os.path.join(script_dir, "dictionary.db")

    # Создаем и заполняем базу данных
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    # Создаем таблицу
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS entries (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
    """)
    
    # Вставляем данные
    cursor.executemany(
        "INSERT OR REPLACE INTO entries (key, value) VALUES (?, ?)",
        [(key, value) for key, value in data.items()]
    )
    
    conn.commit()
    conn.close()
    
    print(f"База данных успешно создана: {db_path}")
    print(f"Обработано записей: {len(data)}")

if __name__ == "__main__":
    main()