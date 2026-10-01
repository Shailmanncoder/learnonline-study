// Keep only explicit user preferences; assistant guesses never become memory.
function preferences(messages) {
    const remembered=new Map();
    const patterns={
        class:/\b(?:i am in|i'm in|my class is|i study in)\s*(?:class|grade)?\s*(1[0-2]|[1-9])\b/i,
        language:/\b(?:reply|answer|respond|explain|speak)\s+(?:to me\s+)?(?:only\s+)?in\s+(hindi|english|hinglish)\b/i,
        detail:/\b(?:keep (?:your |the )?answers? (?:short|brief|detailed)|(?:i prefer|always give) (?:short|brief|detailed) answers?)\b/i
    };
    for(const m of messages) {
        if(m.role!=='user')continue;
        const text=String(m.content || '');
        if(/\b(?:forget|reset|clear) (?:my |the |all )?(?:preferences|memory)\b/i.test(text)){remembered.clear();continue;}
        for(const [key,re] of Object.entries(patterns)) {
            const match=text.match(re);if(match)remembered.set(key,match[0]);
        }
    }
    return [...remembered.values()];
}
const instruction='Use this conversation to resolve short follow-ups, pronouns, corrections and requests such as "one shot", "in Hindi", "make it shorter" or "the second one". Preserve the active topic, class, board and requested format when the user refines them. A clear topic change starts a new topic. The latest explicit request overrides older preferences and the study profile. Ask one brief clarification only when the referent is ambiguous. Do not treat earlier assistant guesses, chapter numbers, language labels or recommendations as verified facts. Never claim a new search or source check unless a tool performed it. Memory is scoped to this conversation, not all chats.';
module.exports={preferences,instruction};
