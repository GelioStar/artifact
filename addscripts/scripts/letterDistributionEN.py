# -*- coding: utf-8 -*-
"""
analyze_english_letters.py

Анализ распределения букв в английских словах по трём частям:
  A) равные трети по буквам
  B) эвристическая морфемная сегментация (через лемму WordNet)

Для каждой части считаются частоты букв отдельно для гласных и согласных,
и в терминал выводятся списки (буква — количество — процент внутри своей группы).
"""

import re
import sys
from collections import Counter
from tkinter import Tk, filedialog

# ----------------------------
# Зависимости для лемматизации
# ----------------------------
try:
    import nltk
    from nltk.stem import WordNetLemmatizer
    from nltk.corpus import wordnet
    from nltk import pos_tag
except Exception:
    print("Требуется nltk. Установите через: pip install nltk")
    sys.exit(1)

# Попытаемся скачать ресурсы, если их нет (безопасно: nltk проверит и не скачает заново)
try:
    nltk.data.find("corpora/wordnet")
except LookupError:
    print("Скачиваю wordnet (NLTK)...")
    nltk.download("wordnet")
    nltk.download("omw-1.4")

try:
    nltk.data.find("taggers/averaged_perceptron_tagger")
except LookupError:
    print("Скачиваю averaged_perceptron_tagger (NLTK)...")
    nltk.download("averaged_perceptron_tagger")

# ----------------------------
# Конфигурация
# ----------------------------
# Внимание: по умолчанию 'y' считается согласной. Если хотите считать 'y' как гласную,
# добавьте 'y' в VOWELS ниже.
VOWELS = set("aeiou")
CONSONANTS = set("abcdefghijklmnopqrstuvwxyz") - VOWELS

LETTER_RE = re.compile(r'[A-Za-z]')

# ----------------------------
# Утилиты выбора файла
# ----------------------------
def choose_file_dialog():
    root = Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    file_path = filedialog.askopenfilename(
        title="Выберите .txt файл (каждое слово — на строке, кодировка UTF-8)",
        filetypes=[("text files", "*.txt"), ("all files", "*.*")]
    )
    root.destroy()
    return file_path

# ----------------------------
# Простейшая очистка / извлечение букв
# ----------------------------
def extract_letters(word):
    """Возвращает список букв (ASCII) в нижнем регистре."""
    return [m.group(0).lower() for m in LETTER_RE.finditer(word)]

# ----------------------------
# Деление на три равные части
# ----------------------------
def split_into_three_equalletters(letters):
    L = len(letters)
    if L == 0:
        return [], [], []
    a = (L + 2) // 3
    b = (2 * L + 1) // 3
    return letters[:a], letters[a:b], letters[b:]

# ----------------------------
# Эвристическая морфемная сегментация через лемму
# ----------------------------
def longest_common_prefix(a, b):
    n = min(len(a), len(b))
    i = 0
    while i < n and a[i] == b[i]:
        i += 1
    return i

def longest_common_suffix(a, b):
    n = min(len(a), len(b))
    i = 0
    while i < n and a[-1 - i] == b[-1 - i]:
        i += 1
    return i

# map POS tag from nltk.pos_tag to wordnet POS for lemmatizer
def penn_to_wordnet_pos(tag):
    if tag.startswith("J"):
        return wordnet.ADJ
    elif tag.startswith("V"):
        return wordnet.VERB
    elif tag.startswith("N"):
        return wordnet.NOUN
    elif tag.startswith("R"):
        return wordnet.ADV
    else:
        return None

lemmatizer = WordNetLemmatizer()

def morph_segmentation_heuristic(word_letters):
    """
    Возвращает (prefix, root, suffix) — списки букв.
    Использует лемматизацию: находит лемму, затем общий префикс/суффикс между исходной формой
    и леммой. Центральная часть считается корнем. Защита от перекрытия аналогична русской реализации.
    """
    if not word_letters:
        return [], [], []

    word = "".join(word_letters)
    # получаем POS для более корректной лемматизации
    try:
        tags = pos_tag([word])
        pos = penn_to_wordnet_pos(tags[0][1])
    except Exception:
        pos = None

    if pos:
        lemma = lemmatizer.lemmatize(word, pos=pos)
    else:
        lemma = lemmatizer.lemmatize(word)

    lemma_letters = [c for c in lemma if LETTER_RE.match(c)]

    pref = longest_common_prefix(word_letters, lemma_letters)
    suf = longest_common_suffix(word_letters, lemma_letters)

    L = len(word_letters)
    if pref + suf >= L:
        # сделать резервное разделение, чтобы root не было пусто
        if L >= 3:
            pref = 1
            suf = 1
        elif L == 2:
            pref = 1
            suf = 0
        else:
            pref = 0
            suf = 0

    p = word_letters[:pref]
    root = word_letters[pref:L - suf] if (L - suf) > pref else []
    s = word_letters[L - suf:] if suf > 0 else []

    # Если root пуст и слово длиннее 1 — обеспечим 1 символ в корне
    if not root and L > 1:
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

# ----------------------------
# Подсчёт и вывод результатов
# ----------------------------
def update_counters_for_parts(counters, totals, parts):
    for idx, part in enumerate(parts, start=1):
        counters[idx].update(part)
        totals[idx] += len(part)

def compute_and_print_results(title, counters, totals):
    print("\n" + "=" * 80)
    print(title)
    print("=" * 80)
    for idx in (1, 2, 3):
        part_total = totals[idx]
        print(f"\n--- Part {idx} — total letters in this part: {part_total}")
        vowel_counts = {ch: cnt for ch, cnt in counters[idx].items() if ch in VOWELS}
        cons_counts = {ch: cnt for ch, cnt in counters[idx].items() if ch in CONSONANTS}
        total_vowels = sum(vowel_counts.values())
        total_consonants = sum(cons_counts.values())

        print(f"\nConsonants (total {total_consonants}):")
        if total_consonants == 0:
            print("  (no consonants in this part)")
        else:
            sorted_cons = sorted(cons_counts.items(), key=lambda x: (-x[1], x[0]))
            for ch, cnt in sorted_cons:
                pct = cnt / total_consonants * 100
                print(f"  {ch} — {cnt} ({pct:.8f}%)")

        print(f"\nVowels (total {total_vowels}):")
        if total_vowels == 0:
            print("  (no vowels in this part)")
        else:
            sorted_vowels = sorted(vowel_counts.items(), key=lambda x: (-x[1], x[0]))
            for ch, cnt in sorted_vowels:
                pct = cnt / total_vowels * 100
                print(f"  {ch} — {cnt} ({pct:.8f}%)")
    print("\n" + "=" * 80 + "\n")

# ----------------------------
# Main
# ----------------------------
def main():
    print("English letters distribution analysis (three equal parts and morphological heuristic).")
    print("Choose input .txt file (UTF-8), each word on its own line.\n")
    file_path = choose_file_dialog()
    if not file_path:
        print("No file chosen. Exit.")
        sys.exit(1)

    try:
        with open(file_path, "r", encoding="utf-8") as f:
            raw_lines = f.readlines()
    except Exception as e:
        print(f"Could not open file: {e}")
        sys.exit(1)

    counters_equal = {1: Counter(), 2: Counter(), 3: Counter()}
    totals_equal = {1: 0, 2: 0, 3: 0}

    counters_morph = {1: Counter(), 2: Counter(), 3: Counter()}
    totals_morph = {1: 0, 2: 0, 3: 0}

    n_read = 0
    n_skipped = 0
    for line in raw_lines:
        word_raw = line.strip()
        if not word_raw:
            continue
        n_read += 1
        letters = extract_letters(word_raw)
        if not letters:
            n_skipped += 1
            continue

        # Approach A: equal thirds
        p1, p2, p3 = split_into_three_equalletters(letters)
        update_counters_for_parts(counters_equal, totals_equal, (p1, p2, p3))

        # Approach B: morphological heuristic
        mp1, mp2, mp3 = morph_segmentation_heuristic(letters)
        update_counters_for_parts(counters_morph, totals_morph, (mp1, mp2, mp3))

    print(f"\nProcessed words: {n_read}; skipped (no letters): {n_skipped}")

    compute_and_print_results("RESULT: Equal thirds (by letters)", counters_equal, totals_equal)
    compute_and_print_results("RESULT: Morphological heuristic (WordNet lemmatizer)", counters_morph, totals_morph)

    print("Analysis finished.")

if __name__ == "__main__":
    main()
