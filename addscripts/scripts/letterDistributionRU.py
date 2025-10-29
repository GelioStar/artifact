# -*- coding: utf-8 -*-

"""
analyze_russian_letters.py

Считывает файл .txt (каждое слово — на своей строке, кодировка UTF-8),
производит два анализа:
  1) разделение слова на равные трети по символам,
  2) морфемная (эвристическая) сегментация на prefix|root|suffix с помощью pymorphy3

Для каждого подхода считает частоты букв (гласные / согласные) в каждой трети
и выводит в терминал отсортированные списки в процентах по убыванию.
"""

import re
import sys
from collections import Counter, defaultdict
from tkinter import Tk, filedialog
import pymorphy3

# Конфигурация алфавита
VOWELS = set(list("аеёиоуыэюя"))
# Считаем эти символы за согласные (включая ь/ъ)
CONSONANTS = set(list("бвгджзйклмнпрстфхцчшщьъ"))

CYRILLIC_LET_RE = re.compile(r'[а-яё]', flags=re.IGNORECASE)


def choose_file_dialog():
    root = Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    file_path = filedialog.askopenfilename(
        title="Выберите .txt файл (каждое слово — на строке)",
        filetypes=[("text files", "*.txt"), ("all files", "*.*")]
    )
    root.destroy()
    return file_path


def extract_letters(word):
    """Возвращает список кириллических букв в нижнем регистре (без других символов)."""
    return [m.group(0).lower() for m in CYRILLIC_LET_RE.finditer(word)]


def split_into_three_equalletters(letters):
    """
    Делит список букв на три части приближённо равной длины.
    Возвращает кортеж (part1, part2, part3) — каждый как список букв.
    """
    L = len(letters)
    if L == 0:
        return [], [], []
    # используем целочисленные формулы, как в описании: a = ceil(L/3), b = ceil(2L/3)
    a = (L + 2) // 3
    b = (2 * L + 1) // 3
    p1 = letters[:a]
    p2 = letters[a:b]
    p3 = letters[b:]
    return p1, p2, p3


def longest_common_prefix(a, b):
    """Длина наибольшего общего префикса двух последовательностей."""
    n = min(len(a), len(b))
    i = 0
    while i < n and a[i] == b[i]:
        i += 1
    return i


def longest_common_suffix(a, b):
    """Длина наибольшего общего суффикса двух последовательностей."""
    n = min(len(a), len(b))
    i = 0
    while i < n and a[-1 - i] == b[-1 - i]:
        i += 1
    return i


def morph_segmentation_heuristic(word_letters, analyzer):
    """
    Эвристическая морфемная сегментация:
    - получаем лемму через pymorphy3,
    - находим общий префикс и суффикс между исходным словом и леммой,
    - центральная часть между ними считаем 'корнем'.
    Возвращает (prefix_letters, root_letters, suffix_letters).
    Если сегментация не удаётся (корень пустой), применяем запасной план:
    - деление: 1 символ в prefix, middle в root, остальное suffix (чтобы не было пустых частей).
    """
    if not word_letters:
        return [], [], []

    word = "".join(word_letters)
    parses = analyzer.parse(word)
    if not parses:
        # если анализатор ничего не дал — fallback: равные трети
        return split_into_three_equalletters(word_letters)

    # берем лучшую разборку
    best = parses[0]
    lemma = best.normal_form  # строка
    lemma_letters = [c for c in lemma if CYRILLIC_LET_RE.match(c)]

    # вычисляем длинны совпадающих префикса/суффикса
    pref = longest_common_prefix(word_letters, lemma_letters)
    suf = longest_common_suffix(word_letters, lemma_letters)

    # Защита от перекрытия:
    L = len(word_letters)
    if pref + suf >= L:
        # слишком много совпадения — делаем резервное разделение, чтобы root не было пусто
        if L >= 3:
            pref = 1
            suf = 1
        elif L == 2:
            pref = 1
            suf = 0
        else:
            pref = 0
            suf = 0

    # Формируем части
    p = word_letters[:pref]
    root = word_letters[pref:L - suf] if (L - suf) > pref else []
    s = word_letters[L - suf:] if suf > 0 else []

    # Если root пуст и слово длиннее 1 — гарантируем минимум один символ в корне
    if not root and L > 1:
        # поместим один символ в корень, сдвинув из suffix или prefix
        if s:
            root = [s[0]]
            s = s[1:]
        elif p:
            root = [p[-1]]
            p = p[:-1]
        else:
            root = [word_letters[0]]
            p = []
            s = word_letters[1:]
    return p, root, s


def update_counters_for_parts(counters, totals, parts):
    """
    parts: iterable of 3 lists of letters.
    counters: dict index->Counter
    totals: dict index->int
    """
    for idx, part in enumerate(parts, start=1):
        counters[idx].update(part)
        totals[idx] += len(part)


def compute_and_print_results(title, counters, totals):
    """
    counters: dict {1:Counter(), 2:Counter(), 3:Counter()}
    totals: dict {1:int,2:int,3:int}
    Для каждой части печатаем отдельные списки для согласных и гласных,
    процент считается относительно общего числа букв данного типа (vowels/consonants) в этой части.
    """
    print("\n" + "=" * 80)
    print(f"{title}")
    print("=" * 80)
    for idx in (1, 2, 3):
        part_total = totals[idx]
        print(f"\n--- Часть {idx} — всего букв в части: {part_total}")
        # Считаем отдельно суммы для гласных и согласных
        vowel_counts = {ch: cnt for ch, cnt in counters[idx].items() if ch in VOWELS}
        cons_counts = {ch: cnt for ch, cnt in counters[idx].items() if ch in CONSONANTS}
        total_vowels = sum(vowel_counts.values())
        total_consonants = sum(cons_counts.values())

        # Вывод согласных
        print(f"\nСогласные (всего {total_consonants}):")
        if total_consonants == 0:
            print("  (нет согласных в этой части)")
        else:
            # сортируем по убыванию частоты, затем по букве
            sorted_cons = sorted(cons_counts.items(), key=lambda x: (-x[1], x[0]))
            for ch, cnt in sorted_cons:
                pct = cnt / total_consonants * 100
                print(f"  {ch} — {cnt} ({pct:.8f}%)")

        # Вывод гласных
        print(f"\nГласные (всего {total_vowels}):")
        if total_vowels == 0:
            print("  (нет гласных в этой части)")
        else:
            sorted_vowels = sorted(vowel_counts.items(), key=lambda x: (-x[1], x[0]))
            for ch, cnt in sorted_vowels:
                pct = cnt / total_vowels * 100
                print(f"  {ch} — {cnt} ({pct:.8f}%)")
    print("\n" + "=" * 80 + "\n")


def main():
    print("Анализ распределения букв по трем частям слова (равные трети и морфемная сегментация).")
    print("Выберите входной .txt файл (UTF-8), каждое слово — на отдельной строке.\n")

    file_path = choose_file_dialog()
    if not file_path:
        print("Файл не выбран. Выход.")
        sys.exit(1)

    try:
        with open(file_path, "r", encoding="utf-8") as f:
            raw_lines = f.readlines()
    except Exception as e:
        print(f"Не удалось открыть файл: {e}")
        sys.exit(1)

    # создаём анализатор pymorphy3
    morph = pymorphy3.MorphAnalyzer()

    # Общие счётчики для обоих подходов
    # Подход A: равные трети
    counters_equal = {1: Counter(), 2: Counter(), 3: Counter()}
    totals_equal = {1: 0, 2: 0, 3: 0}

    # Подход B: морфемная сегментация (prefix|root|suffix)
    counters_morph = {1: Counter(), 2: Counter(), 3: Counter()}
    totals_morph = {1: 0, 2: 0, 3: 0}

    # Считываем слова, чистим, обрабатываем
    n_read = 0
    n_skipped_nonletters = 0
    for line in raw_lines:
        word_raw = line.strip()
        if not word_raw:
            continue
        n_read += 1
        letters = extract_letters(word_raw)
        if not letters:
            n_skipped_nonletters += 1
            continue

        # Подход A
        p1, p2, p3 = split_into_three_equalletters(letters)
        update_counters_for_parts(counters_equal, totals_equal, (p1, p2, p3))

        # Подход B (морфемная эвристика)
        mp1, mp2, mp3 = morph_segmentation_heuristic(letters, morph)
        update_counters_for_parts(counters_morph, totals_morph, (mp1, mp2, mp3))

    print(f"\nОбработано слов: {n_read}; пропущено (без кириллических букв): {n_skipped_nonletters}")

    # Печатаем результаты
    compute_and_print_results("РЕЗУЛЬТАТ: Равные трети (по символам)", counters_equal, totals_equal)
    compute_and_print_results("РЕЗУЛЬТАТ: Морфемная (эвристическая) сегментация с pymorphy3", counters_morph, totals_morph)

    print("Анализ завершён.")

if __name__ == "__main__":
    main()
