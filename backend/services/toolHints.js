'use strict';
// ================================================================
// "That is a tool's job"
// ----------------------------------------------------------------
// A plan sells packaged workflows, not knowledge. You cannot gate what a
// chatbot will answer — a student would simply rephrase, and refusing would
// make the free tier hostile for no gain. So the Companion keeps answering.
//
// What was wrong was that it answered silently, and a tool the person had
// paid for, or could pay for, was never mentioned. When a question is clearly
// one tool's territory and that tool is not open on their plan, the answer now
// comes with a note saying which tool does this properly and what it adds.
//
// Conservative on purpose: a hint that fires on every vaguely related question
// is nagging, and nagging is worse than silence.
// ================================================================

// Only tools whose territory is recognisable from the question itself. A tool
// that needs a file or a form is not usefully hinted from a chat line.
const CUES = Object.freeze({
    'sql-gen':            /\b(sql|select statement|database query|join (?:two )?tables|write a query)\b/i,
    'regex-builder':      /\b(regex|regular expression|pattern that matches)\b/i,
    'code-explainer':     /\b(explain (?:this|my|the) code|what does this (?:code|function|script) do|walk through this code)\b/i,
    'bug-fixer':          /\b(fix (?:this|my) (?:bug|code|error)|why (?:is|does) (?:my|this) code (?:fail|break|crash|not work)|debug (?:this|my))\b/i,
    'algorithm-tutor':    /\b(time complexity|big[- ]o\b|binary search|sorting algorithm|dynamic programming)\b/i,
    'resume-builder':     /\b(my (?:resume|cv)|write (?:a|my) (?:resume|cv)|resume bullet)\b/i,
    'cover-letter':       /\b(cover letter|letter of application)\b/i,
    'interview-prep':     /\b(interview questions?|prepare for (?:an|my) interview|mock interview)\b/i,
    'email-writer':       /\b(write (?:an|a) email|draft (?:an|a) email|reply to this email)\b/i,
    'citation-generator': /\b(cite this|citation|bibliography|reference list|apa|mla|harvard style)\b/i,
    'mindmap-gen':        /\b(mind ?map|concept map)\b/i,
    'ai-paraphraser':     /\b(paraphrase|reword|rewrite (?:this|it) in (?:my )?own words)\b/i,
    'pros-cons':          /\b(pros and cons|advantages and disadvantages|should i choose between)\b/i,
    'formula-sheet':      /\b(formula sheet|list of formulas|all the formulae)\b/i,
    'vocab-builder':      /\b(vocabulary list|word list to learn|build my vocabulary)\b/i,
    'grammar-tutor':      /\b(is this grammatically|check my grammar|correct this sentence)\b/i
});

// What the tool adds over an answer in a chat window. Specific, and true:
// every one of these is something a saved run gives and a conversation does not.
const ADDS = Object.freeze({
    'sql-gen':            'a schema box, the query formatted, and the run saved to re-use',
    'regex-builder':      'the pattern broken down piece by piece, saved to re-use',
    'code-explainer':     'a paste box for the whole file and the explanation saved beside it',
    'bug-fixer':          'the code and the error together, with the fix saved to compare later',
    'algorithm-tutor':    'the walkthrough saved so you can return to it before an exam',
    'resume-builder':     'your details kept in a form, so each version is one edit away',
    'cover-letter':       'the role and your experience kept, so the next letter is a re-run',
    'interview-prep':     'the question set saved, so you can practise the same one again',
    'email-writer':       'the purpose and tone kept in a form for the next email',
    'citation-generator': 'the style fixed and every citation kept in one place',
    'mindmap-gen':        'a rendered map rather than text, saved to come back to',
    'ai-paraphraser':     'the original and the rewrite side by side, saved',
    'pros-cons':          'the two columns laid out and saved to revisit',
    'formula-sheet':      'the sheet saved to open before an exam',
    'vocab-builder':      'the list saved so it builds up over the term',
    'grammar-tutor':      'the correction saved with the original to learn from'
});

/**
 * The tool whose job this question clearly is, or null.
 * Returns at most one, because two hints on one answer is nagging.
 */
function match(prompt) {
    const text = String(prompt || '');
    if (text.length < 8) return null;
    for (const [toolId, cue] of Object.entries(CUES)) {
        if (cue.test(text)) return toolId;
    }
    return null;
}

module.exports = { match, ADDS, CUES };
