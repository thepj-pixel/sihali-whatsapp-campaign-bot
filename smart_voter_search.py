"""
SMART VOTER SEARCH ENGINE — SIHALI KHURD (अलवर, राजस्थान)
Supports:
1. Hindi / English / Hinglish queries
2. Typo-tolerant fuzzy search (e.g. 'reena' <-> 'rina', 'pirnce' <-> 'prince', 'mnoj' <-> 'manoj')
3. Automatic relevance scoring & closest matches
"""

import csv, re, difflib, os, sys

sys.stdout.reconfigure(encoding='utf-8')

CSV_PATH = os.path.join(os.path.dirname(__file__), 'SIHALI_KHURD_VOTERS_AI_PERFECT.csv')

def load_voters():
    with open(CSV_PATH, 'r', encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)
        return list(reader)

VOTERS = load_voters()

def normalize_phonetic(s):
    if not s: return ""
    s = s.lower().strip()
    s = re.sub(r'ee', 'i', s)
    s = re.sub(r'oo', 'u', s)
    s = re.sub(r'v', 'w', s)
    s = re.sub(r'sh', 's', s)
    s = re.sub(r'ch', 'c', s)
    s = re.sub(r'z', 'j', s)
    s = re.sub(r'(.)\1+', r'\1', s)
    s = re.sub(r'[ीि]', 'ि', s)
    s = re.sub(r'[ूु]', 'ु', s)
    s = re.sub(r'[शष]', 'स', s)
    s = re.sub(r'ण', 'न', s)
    s = re.sub(r'ब', 'व', s)
    s = re.sub(r'[ँं]', 'ं', s)
    return s

TRANSLIT_SYNONYMS = {
    'reena': ['reena', 'rina', 'रीना'],
    'rina': ['reena', 'rina', 'रीना'],
    'rinku': ['rinku', 'रिंकू', 'रिंकु'],
    'pooja': ['pooja', 'puja', 'पूजा'],
    'puja': ['pooja', 'puja', 'पूजा'],
    'kumari': ['kumari', 'कुमारी', 'kmari'],
    'prince': ['prince', 'pirnce', 'princ', 'प्रिंस'],
    'pirnce': ['prince', 'pirnce', 'princ', 'प्रिंस'],
    'abhay': ['abhay', 'abay', 'अभय', 'बाबा'],
    'baba': ['abhay', 'abay', 'अभय', 'बाबा'],
    'manoj': ['manoj', 'mnoj', 'मनोज'],
    'mnoj': ['manoj', 'mnoj', 'मनोज'],
    'yadav': ['yadav', 'यादव'],
    'singh': ['singh', 'सिंह'],
    'kumar': ['kumar', 'कुमार'],
    'devi': ['devi', 'देवी'],
    'sharma': ['sharma', 'शर्मा'],
}

def score_token(row, token):
    if not token: return 0
    t = token.lower()
    variants = TRANSLIT_SYNONYMS.get(t, [t])
    
    name_hi = row.get('नाम_Hindi', '').lower()
    name_en = row.get('Name_English', '').lower()
    rel_hi = row.get('पिता_पति_का_नाम', '').lower()
    rel_en = row.get('Relative_English', '').lower()
    epic = row.get('पहचान_पत्र_EPIC', '').lower()
    ward = str(row.get('वार्ड_नं', ''))
    sr = str(row.get('मतदाता_क्र_Sr', ''))
    house = str(row.get('मकान_नं_House', ''))
    
    # 1. Exact Name match
    if t == name_en or t == name_hi: return 120
    if t in name_en or t in name_hi: return 100
    for v in variants:
        if v in name_en or v in name_hi: return 95
        
    # 2. Exact Relative match
    if t == rel_en or t == rel_hi: return 80
    if t in rel_en or t in rel_hi: return 70
    for v in variants:
        if v in rel_en or v in rel_hi: return 65
        
    # 3. Exact ID / EPIC / Ward / Sr
    if t == epic or t == f"w{ward}" or t == f"वार्ड{ward}": return 110
    if t == sr or t == house: return 50
    
    # 4. Phonetic & Fuzzy Typo matching (for length >= 3)
    if len(t) >= 3:
        norm_t = normalize_phonetic(t)
        all_words = (name_hi + " " + name_en + " " + rel_hi + " " + rel_en).split()
        for w in all_words:
            norm_w = normalize_phonetic(w)
            if norm_w == norm_t: return 85
            if norm_t in norm_w or norm_w in norm_t: return 75
            
            # Fuzzy ratio
            ratio = difflib.SequenceMatcher(None, norm_t, norm_w).ratio()
            if ratio >= 0.75:
                return int(ratio * 70)
                
    return 0

def search_voters(query, limit=5):
    tokens = [tok.strip().lower() for tok in re.split(r'[\s,]+', query) if tok.strip()]
    if not tokens: return []
    
    scored_results = []
    for row in VOTERS:
        total_score = 0
        matched_all = True
        for tok in tokens:
            s = score_token(row, tok)
            if s == 0:
                matched_all = False
                break
            total_score += s
        if matched_all:
            scored_results.append((total_score, row))
            
    # Sort highest score first
    scored_results.sort(key=lambda x: x[0], reverse=True)
    return [r[1] for r in scored_results[:limit]]

if __name__ == '__main__':
    test_queries = ["reena kumari", "rina kumari", "pirnce yadav", "mnoj kumar"]
    for q in test_queries:
        print(f"\n🔍 Query: '{q}'")
        res = search_voters(q, limit=3)
        for i, row in enumerate(res, 1):
            print(f"  {i}. वार्ड {row['वार्ड_नं']} #{row['मतदाता_क्र_Sr']}: {row['नाम_Hindi']} ({row['Name_English']}), {row['संबंध_Type']}: {row['पिता_पति_का_नाम']} ({row['Relative_English']}) [EPIC: {row['पहचान_पत्र_EPIC']}]")
