import os
import yaml
import argparse
from pathlib import Path

def load_yaml_file(file_path):
    """Загрузка YAML файла с обработкой ошибок"""
    try:
        with open(file_path, 'r', encoding='utf-8') as file:
            return yaml.safe_load(file)
    except Exception as e:
        print(f"Ошибка загрузки файла {file_path}: {e}")
        return None

def save_yaml_file(file_path, data):
    """Сохранение данных в YAML файл"""
    try:
        with open(file_path, 'w', encoding='utf-8') as file:
            yaml.dump(data, file, default_flow_style=False, allow_unicode=True, indent=4)
        return True
    except Exception as e:
        print(f"Ошибка сохранения файла {file_path}: {e}")
        return False

def merge_configs(old_config, new_config, path=""):
    """
    Рекурсивное объединение конфигураций.
    Сохраняет значения из old_config если ключи присутствуют в new_config
    """
    if not isinstance(old_config, dict) or not isinstance(new_config, dict):
        return new_config
    
    merged_config = new_config.copy()
    
    for key, old_value in old_config.items():
        if key in new_config:
            current_path = f"{path}.{key}" if path else key
            
            if isinstance(old_value, dict) and isinstance(new_config[key], dict):
                # Рекурсивно обрабатываем вложенные словари
                merged_config[key] = merge_configs(old_value, new_config[key], current_path)
            else:
                # Заменяем значение на старое
                merged_config[key] = old_value
                print(f"Заменено значение: {current_path}")
        else:
            print(f"Пропущен ключ (отсутствует в новом конфиге): {key}")
    
    return merged_config

def process_config_files(old_dir, new_dir, output_dir=None):
    """
    Обработка всех конфигурационных файлов в директориях
    """
    old_path = Path(old_dir)
    new_path = Path(new_dir)
    output_path = Path(output_dir) if output_dir else new_path
    
    # Создаем выходную директорию если она указана и не существует
    if output_dir and not output_path.exists():
        output_path.mkdir(parents=True, exist_ok=True)
    
    # Получаем список YAML файлов в новой директории
    yaml_files = list(new_path.glob("*.yml")) + list(new_path.glob("*.yaml"))
    
    if not yaml_files:
        print(f"Не найдено YAML файлов в директории {new_dir}")
        return
    
    processed_count = 0
    
    for new_file in yaml_files:
        old_file = old_path / new_file.name
        
        if not old_file.exists():
            print(f"Предупреждение: Файл {old_file} не существует, пропускаем")
            continue
        
        print(f"\nОбработка файла: {new_file.name}")
        print("-" * 50)
        
        # Загружаем конфиги
        old_config = load_yaml_file(old_file)
        new_config = load_yaml_file(new_file)
        
        if old_config is None or new_config is None:
            print(f"Ошибка загрузки конфигов для {new_file.name}, пропускаем")
            continue
        
        # Объединяем конфиги
        merged_config = merge_configs(old_config, new_config)
        
        # Определяем путь для сохранения
        if output_dir:
            output_file = output_path / new_file.name
        else:
            output_file = new_file
        
        # Сохраняем результат
        if save_yaml_file(output_file, merged_config):
            print(f"Успешно сохранен: {output_file}")
            processed_count += 1
    
    print(f"\nОбработано файлов: {processed_count}/{len(yaml_files)}")

def main():
    parser = argparse.ArgumentParser(description='Объединение конфигураций Minecraft сервера')
    parser.add_argument('old_dir', help='Директория со старыми конфигами')
    parser.add_argument('new_dir', help='Директория с новыми конфигами')
    parser.add_argument('-o', '--output', help='Выходная директория (по умолчанию - перезапись новых)')
    
    args = parser.parse_args()
    
    if not os.path.exists(args.old_dir):
        print(f"Ошибка: Директория {args.old_dir} не существует")
        return
    
    if not os.path.exists(args.new_dir):
        print(f"Ошибка: Директория {args.new_dir} не существует")
        return
    
    print("=== Объединение конфигураций Minecraft ===")
    print(f"Старые конфиги: {args.old_dir}")
    print(f"Новые конфиги: {args.new_dir}")
    if args.output:
        print(f"Выходная директория: {args.output}")
    else:
        print("Режим: перезапись новых конфигов")
    print("=" * 50)
    
    process_config_files(args.old_dir, args.new_dir, args.output)

if __name__ == "__main__":
    main()