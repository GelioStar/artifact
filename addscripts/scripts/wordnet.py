from nltk.corpus import wordnet as wn
import nltk

nltk.download('wordnet')

lemmas = set()
for synset in wn.all_synsets():
    for lemma in synset.lemmas():
        lemmas.add(lemma.name())

output_path = 'E:/UNIVERSITY/#1_PROJECTS/artifact/addscripts/scripts/wordnet_lemmas.txt'
with open(output_path, 'w', encoding='utf-8') as f:
    for lemma in sorted(lemmas):
        f.write(lemma + '\n')

print(f'Файл сохранён: {output_path}')
