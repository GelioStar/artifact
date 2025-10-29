# coding: utf-8
"""
syllable_freq.py
Считает частоты слогов (в процентах) по леммам слов из входного .txt файла (по одному слову в строке).
Использует pymorphy3 для лемматизации.
Диалог выбора файла реализован через tkinter.filedialog (Windows Explorer / аналог).
"""

import re
import sys
from collections import Counter, defaultdict
from tkinter import Tk, filedialog

try:
    import pymorphy3
except Exception as e:
    print("Ошибка: не удалось импортировать pymorphy3. Установите пакет:\n    pip install pymorphy3")
    raise

morph = pymorphy3.MorphAnalyzer()

# Русские гласные
VOWELS = "аеёиоуыэюя"
VOWELS_SET = set(VOWELS)

# Набор часто встречающихся допустимых начал слогов (для максимального onset).
# Составлен приближённо: несколько десятков распространённых кластеров.
# Можно расширить при желании.
COMMON_ONSETS = {
    "б", "в", "г", "д", "ж", "з", "к", "л", "м", "н", "п", "р", "с", "т", "ф", "х",
    "бл","бр","вл","вр","гл","гр","дл","др","зл","кл","кр","кл","пр","пл","пск","ск","ст",
    "стр","сп","см","скр","скл","сл","сло","тр","тс","фл","фр","хр","шр","шл",
    "стр","ск","скр","скл","бр","тр","др","пр","гр","кр","кл","пл","сл","скл","скв",
    "ч", "ш", "щ", "й", "шк", "шн"
}
# ensure everything lowercase
COMMON_ONSETS = set(s.lower() for s in COMMON_ONSETS)

CYRILLIC_LETTER_RE = re.compile(r'[а-яёА-ЯЁ]+', re.UNICODE)

def normalize_word(word: str) -> str:
    """Оставляем только кириллические буквы, переводим в нижний регистр."""
    if not word:
        return ""
    m = CYRILLIC_LETTER_RE.search(word)
    if not m:
        return ""
    cleaned = m.group(0).lower()
    return cleaned

def lemmatize(word: str) -> str:
    """Лемматизация через pymorphy3; если не получилось — вернуть исходное."""
    try:
        p = morph.parse(word)
        if not p:
            return word
        # берем первую (наиболее частотную) разборку
        return p[0].normal_form
    except Exception:
        return word

def syllabify_simple(word: str) -> list:
    """
    Простейшее слогоразделение:
    - Ядро слога — гласная.
    - Между двумя гласными: если одна согласная -> она уходит в начало следующего слога (V C V -> V-CV).
      Если несколько согласных -> последняя переходит к следующему слогу (V C1 C2 ... Cn V -> V C1...C(n-1) | Cn V).
    - Начальные/конечные согласные остаются с ближайшей гласной (т.е. 'страна' -> 'стра-на' с этим правилом обычно получится 'ст-ра-на', но это упрощение).
    """
    w = word.lower()
    if not w:
        return []
    # если нет гласных — считаем слово одним "слогом" (встречается редко)
    if not any(ch in VOWELS_SET for ch in w):
        return [w]

    vowel_positions = [i for i, ch in enumerate(w) if ch in VOWELS_SET]
    syllables = []
    start = 0
    for vi, vpos in enumerate(vowel_positions):
        # find boundary to next syllable
        if vi == len(vowel_positions) - 1:
            # last vowel -> take rest of word
            syllables.append(w[start:])
            break
        next_vpos = vowel_positions[vi + 1]
        # cluster of consonants between vpos and next_vpos
        between = w[vpos+1:next_vpos]
        if len(between) <= 1:
            cut = next_vpos - 0  # put single consonant to next syllable
            # but ensure current syllable is not empty
            if cut == start:
                cut = start + 1
        else:
            # при нескольких согласных: оставляем все кроме последней в текущем слоге
            cut = next_vpos - 1
        # make sure cut is > start to avoid infinite loops
        if cut <= start:
            cut = start + 1
        syll = w[start:cut]
        syllables.append(syll)
        start = cut
    return syllables

def syllabify_max_onset(word: str) -> list:
    """
    Более продвинутая версия: пытается дать следующему слогу максимально длинный допустимый onset,
    опираясь на COMMON_ONSETS. Если не находит — откатывается к простому правилу (последняя согласная к началу).
    """
    w = word.lower()
    if not w:
        return []
    if not any(ch in VOWELS_SET for ch in w):
        return [w]

    vowel_positions = [i for i, ch in enumerate(w) if ch in VOWELS_SET]
    syllables = []
    start = 0
    for vi, vpos in enumerate(vowel_positions):
        if vi == len(vowel_positions) - 1:
            syllables.append(w[start:])
            break
        next_vpos = vowel_positions[vi + 1]
        between = w[vpos+1:next_vpos]  # consonant cluster between vowels
        # try to assign as much as possible to onset of next syllable
        assigned_to_next = ""
        if between:
            for k in range(len(between), 0, -1):
                candidate = between[-k:]
                if candidate in COMMON_ONSETS:
                    assigned_to_next = candidate
                    break
        if assigned_to_next:
            cut = next_vpos - len(assigned_to_next)
            if cut <= start:
                cut = next_vpos - 1
        else:
            # fallback: простое правило: последняя согласная уходит в начало следующего слога
            cut = next_vpos - 1
            if cut <= start:
                cut = start + 1
        syll = w[start:cut]
        syllables.append(syll)
        start = cut
    return syllables

def process_file(path: str, use_max_onset: bool = False, lemmatize_words: bool = True):
    """
    Обрабатывает файл, возвращает Counter слогов и общую статистику.
    """
    syll_counter = Counter()
    words_processed = 0
    skipped = 0
    total_syllables = 0

    with open(path, 'r', encoding='utf-8') as f:
        for raw_line in f:
            line = raw_line.strip()
            if not line:
                continue
            # берём первую кириллическую часть, приводим к нижнему регистру
            cleaned = normalize_word(line)
            if not cleaned:
                skipped += 1
                continue
            if lemmatize_words:
                lemma = lemmatize(cleaned)
            else:
                lemma = cleaned
            # если лемма содержит дефис/точки и т.д. — разобьём на части
            parts = re.split(r'[-\s]', lemma)
            for part in parts:
                part = part.strip()
                if not part:
                    continue
                # choose syllabifier
                sylls = syllabify_max_onset(part) if use_max_onset else syllabify_simple(part)
                # filter possible empty strings
                sylls = [s for s in sylls if s]
                for s in sylls:
                    syll_counter[s] += 1
                total_syllables += len(sylls)
            words_processed += 1

    return {
        "syllables": syll_counter,
        "words_processed": words_processed,
        "skipped_non_cyrillic": skipped,
        "total_syllables": total_syllables
    }

def choose_file_with_dialog():
    root = Tk()
    root.withdraw()
    root.attributes('-topmost', True)
    file_path = filedialog.askopenfilename(
        title="Выберите .txt файл со словами (по одному слову в строке)",
        filetypes=[("Text files", "*.txt"), ("All files", "*.*")]
    )
    root.destroy()
    return file_path

def print_results(stats: dict, top_n: int = None):
    syll_counter = stats["syllables"]
    total = stats["total_syllables"]
    words_processed = stats["words_processed"]
    skipped = stats["skipped_non_cyrillic"]

    if total == 0:
        print("Ничего не найдено для подсчёта слогов.")
        return

    print(f"\nОбработано слов: {words_processed}, пропущено (нет кириллицы): {skipped}")
    print(f"Всего слогов: {total}\n")
    # sort by count desc, then syllable
    items = sorted(syll_counter.items(), key=lambda x: (-x[1], x[0]))
    if top_n is None:
        top_n = len(items)

    print(f"{'№':>3}  {'Слог':<12} {'Кол-во':>8}  {'Процент':>8}")
    print("-"*38)
    for i, (syll, cnt) in enumerate(items[:top_n], start=1):
        pct = cnt / total * 100.0
        print(f"{i:3d}. {syll:<12} {cnt:8d}  {pct:7.12f}%")
    # optionally save to file
    # with open('syllable_freq_output.txt', 'w', encoding='utf-8') as out:
    #     for syll, cnt in items:
    #         out.write(f"{syll}\t{cnt}\t{cnt/total*100:.6f}\n")

def main():
    print("=== Подсчёт частоты слогов (pymorphy3 + эвристическое слогоразделение) ===")
    path = choose_file_with_dialog()
    if not path:
        print("Файл не выбран. Выход.")
        sys.exit(0)
    print(f"Выбран файл: {path}")

    # Параметры: можно менять здесь при необходимости
    use_max_onset = False      # True -> пробует maximal onset с COMMON_ONSETS
    lemmatize_words = True     # True -> лемматизируем через pymorphy3

    stats = process_file(path, use_max_onset=use_max_onset, lemmatize_words=lemmatize_words)
    print_results(stats)

if __name__ == "__main__":
    main()
