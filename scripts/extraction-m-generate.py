#!/usr/bin/env python3
"""Generate the 30 documents for the extraction-M run from the fixed prompts.json (one call each, no edits).
Keys come from ~/.config/FP/provider-keys.env and are sent only in request headers."""
import json, os, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'docs', 'research', 'data', 'extraction-m')
keys = {}
for ln in open(os.path.expanduser('~/.config/FP/provider-keys.env')):
    ln = ln.strip().removeprefix('export ')
    if '=' in ln:
        k, v = ln.split('=', 1)
        keys[k] = v.strip().strip('"').strip("'")
spec = json.load(open(os.path.join(HERE, 'prompts.json')))

def post(url, body, headers):
    req = urllib.request.Request(url, json.dumps(body).encode(), {'content-type': 'application/json', **headers})
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.load(r)

def gen(item):
    model = spec['models'][item['model']]
    if item['model'] == 'g':
        d = post(f'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent',
                 {'contents': [{'role': 'user', 'parts': [{'text': item['prompt']}]}]},
                 {'x-goog-api-key': keys['GEMINI_API_KEY']})
        text = ''.join(p.get('text', '') for p in d['candidates'][0]['content']['parts'])
    else:
        d = post('https://api.openai.com/v1/chat/completions',
                 {'model': model, 'messages': [{'role': 'user', 'content': item['prompt']}]},
                 {'authorization': 'Bearer ' + keys['OPENAI_API_KEY']})
        text = d['choices'][0]['message']['content']
    open(os.path.join(HERE, 'docs', item['id'] + '.txt'), 'w').write(text)
    return item['id'], model, len(text)

with ThreadPoolExecutor(6) as ex:
    for r in ex.map(gen, spec['items']):
        print(*r)
