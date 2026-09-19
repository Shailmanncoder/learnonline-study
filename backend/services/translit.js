// ================================================================
// Devanagari <-> Latin loose matching
// ----------------------------------------------------------------
// Students type chapter names the way they say them — "aisi baate bhi
// hoti hain" for "ऐसी भी बातें होती हैं". Matching only the Devanagari
// form meant the tutor reported a real chapter as non-existent.
//
// This is deliberately lossy: the goal is that two spellings of the same
// title collide, not faithful ISO 15919. Long/short vowels, retroflex vs
// dental, aspirated vs plain and final nasals all fold together, because
// that is exactly where informal romanisation varies.
// ================================================================

const MAP = {
    // independent vowels
    'अ':'a','आ':'a','इ':'i','ई':'i','उ':'u','ऊ':'u','ऋ':'ri','ए':'e','ऐ':'ai',
    'ओ':'o','औ':'au','ऑ':'o','ऍ':'e',
    // dependent vowel signs
    'ा':'a','ि':'i','ी':'i','ु':'u','ू':'u','ृ':'ri','े':'e','ै':'ai','ो':'o','ौ':'au','ॉ':'o','ॅ':'e',
    // consonants
    'क':'k','ख':'k','ग':'g','घ':'g','ङ':'n',
    'च':'c','छ':'ch','ज':'j','झ':'j','ञ':'n',
    'ट':'t','ठ':'t','ड':'d','ढ':'d','ण':'n',
    'त':'t','थ':'t','द':'d','ध':'d','न':'n',
    'प':'p','फ':'f','ब':'b','भ':'b','म':'m',
    'य':'y','र':'r','ल':'l','ळ':'l','व':'v',
    'श':'s','ष':'s','स':'s','ह':'h',
    // nukta forms
    'क़':'k','ख़':'k','ग़':'g','ज़':'j','ड़':'d','ढ़':'d','फ़':'f','य़':'y',
    // signs
    'ं':'n','ँ':'n','ः':'h','़':'', '्':'', 'ऽ':'',
    '।':' ','॥':' ','॰':' '
};

// Latin spellings that vary freely in informal romanisation.
function fold(s) {
    return s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/aa+/g, 'a').replace(/ee+/g, 'i').replace(/ii+/g, 'i')
        .replace(/oo+/g, 'u').replace(/uu+/g, 'u')
        .replace(/kh|gh|th|dh|ph|bh|ch|sh/g, (m) => m[0] === 'c' ? 'c' : m[0])
        .replace(/w/g, 'v').replace(/z/g, 'j').replace(/q/g, 'k').replace(/x/g, 'ks')
        // फ is written "ph" or "f" and both must land on the same token
        .replace(/f/g, 'p')
        .replace(/([a-z])\1+/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
}

const CONSONANT = /[\u0915-\u0939\u0958-\u095F]/;
const MATRA = /[\u093E-\u094C\u094E\u0955-\u0957\u0962\u0963]/;

function romanize(text) {
    const src = String(text || '');
    let out = '';
    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        out += (ch in MAP) ? MAP[ch] : ch;
        // Devanagari carries an inherent 'a' after a consonant unless a vowel
        // sign or virama follows: कथा is "katha", not "kth". Without this the
        // romanised title never lines up with how a student types it.
        if (CONSONANT.test(ch)) {
            const next = src[i + 1] || '';
            if (!MATRA.test(next) && next !== '\u094D' && next !== '\u093C') out += 'a';
        }
    }
    return fold(out);
}

// Tokens worth matching on: drop the scaffolding words that appear in
// every chapter title and carry no identity.
const STOP = new Set(['pat','path','adhyay','adhyaya','chapter','bhag','part',
    'ka','ke','ki','ko','se','me','men','aur','or','hai','hain','h','tha','thi']);

function tokens(text) {
    return fold(romanize(text)).split(' ').filter(t => t.length >= 2 && !STOP.has(t));
}

// Share of the query's meaningful tokens present in the candidate title.
function titleScore(query, title) {
    const q = tokens(query);
    if (!q.length) return 0;
    const t = new Set(tokens(title));
    let hit = 0;
    for (const term of new Set(q)) hit += looseHit(term, t);
    return hit / new Set(q).size;
}

// Does the question NAME this title? Scored the other way round from
// titleScore: the share of the TITLE's tokens present in the question, so a
// long question mentioning a short book name still matches ("tell me about
// Exploration book" names "Exploration").
//
// Generic words are excluded from the evidence, otherwise a book called
// "Science" would be "named" by every question containing the word science.
// Written in their natural spelling and folded through the same pipeline, so
// they match the folded forms tokens() produces — "textbook" becomes
// "tekstbuk" and "भाग" becomes "baga", neither of which matches a raw list.
const GENERIC = new Set([
    'science', 'mathematics', 'math', 'maths', 'ganit', 'ganita', 'vigyan',
    'hindi', 'english', 'sanskrit', 'urdu', 'social', 'studies',
    'textbook', 'book', 'books', 'class', 'part', 'volume', 'new', 'ncert',
    'for', 'and', 'the', 'of', 'bhag', 'भाग', 'पुस्तक', 'कक्षा',
    // Class numbers in book titles identify nothing on their own.
    'i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x', 'xi', 'xii'
].flatMap((w) => [fold(w), fold(romanize(w))]).filter(Boolean));

// Romanised Indic words vary mostly in vowels — "ganit"/"ganita",
// "manjri"/"manjari" are the same word. Comparing consonant skeletons makes
// those collide without loosening matching for unrelated words.
const skeleton = (w) => w.replace(/[aeiou]/g, '') || w;

function looseHit(term, pool) {
    if (pool.has(term)) return 1;
    const sk = skeleton(term);
    // Skeleton equality is stronger evidence than a shared prefix, so it is
    // tested first: "kshitij" vs "ksitija" is the same word, not a near miss.
    // Only for skeletons with enough consonants to be distinctive. A two-
    // letter skeleton collides with half the language: the Roman numeral in
    // "Class IX" folds to "iks" -> "ks", identical to "kaise" -> "ks", so any
    // question containing "kaise" was selecting the Class IX Science book.
    if (sk.length >= 3) {
        for (const x of pool) if (skeleton(x) === sk) return 1;
    }
    for (const x of pool) if (x.startsWith(term) || term.startsWith(x)) return 0.5;
    return 0;
}

function namesTitle(question, title) {
    const t = tokens(title).filter(x => !GENERIC.has(x));
    if (!t.length) return 0;                 // nothing distinctive to match on
    const q = new Set(tokens(question));
    let hit = 0;
    for (const term of new Set(t)) hit += looseHit(term, q);
    return hit / new Set(t).size;
}

module.exports = { romanize, fold, tokens, titleScore, namesTitle };
