// Feature display catalogue. The payment server owns prices and entitlements.
(() => {
    const common = ['Automatic model selection', 'Light and dark appearance', 'Responsive desktop and mobile workspace'];
    window.plusCatalog = {
        currency: 'INR', interval: 'month', checkoutEnabled: true,
        student: {
            name: 'Student Plus', price: 999, eyebrow: 'FOR YOUR NEXT BREAKTHROUGH',
            description: 'One place to understand, practise and prepare.',
            highlights: ['AI Companion with conversation memory', 'Exam Prep with your own study material', 'Personal study roadmaps', 'The complete AI tool collection', 'NCERT discovery and source library', 'Notes, practice and progress in one workspace'],
            groups: [
                { name: 'Your AI Companion', items: [
                    ['Contextual conversations', 'Continue a thread, ask follow-up questions and revisit saved chats.'],
                    ['Automatic model selection', 'Short questions use a faster model; detailed problems use a stronger model. Available providers can act as backups.'],
                    ['Memory you control', 'Manage saved preferences and uploaded PDF memory.'],
                    ['Web lookup', 'Ask for current information with retrieved source links when search is available.'],
                    ['YouTube recommendations', 'Find candidates by topic, class, lesson format and preferred language. Recommendations use available metadata, not a guarantee of full syllabus coverage.'],
                    ['Study modes', 'Use study tools, guided questions and research from the conversation.'],
                    ['Visible progress', 'See actual lookup and generation steps while the answer is prepared.'],
                    ['Answer actions', 'Copy, save to notes, listen, ask for a quiz or a simpler explanation.'],
                    ['Voice input', 'Dictate questions in browsers that support speech recognition.']
                ]},
                { name: 'Preparation that stays organised', items: [
                    ['Exam Prep', 'Create a preparation from a topic, exam date and your own study sources.'],
                    ['Study material uploads', 'Use PDF, image, DOCX, PPTX and text sources in Exam Prep, up to 6 MB per file. Review extracted content before using it.'],
                    ['Timed practice papers', 'Generate a paper, save answers as you work and see feedback after submission. AI scores are practice feedback.'],
                    ['Detailed study roadmaps', 'Set your goal, number of days and daily study time. Longer plans are generated in batches with visible progress.'],
                    ['Roadmap progress', 'Track completed days, continue generation and export your plan.'],
                    ['Study Studio', 'Build personal learning packs, review material and practise with learning checks.'],
                    ['Learning follow-ups', 'Use baseline, practice, follow-up and retention checks to revisit your understanding.'],
                    ['NCERT discovery', 'Browse classes 1–12, books and chapters. Tutor answers use indexed sources where available; coverage varies by edition.'],
                    ['Online Auto Study preview', 'Explore class, book and chapter selection with sample content and a scripted tutor. This preview does not yet save progress or use live AI.'],
                    ['Source library', 'Explore available textbook and practice references with source details.']
                ]},
                { name: 'Your everyday workspace', items: [
                    ['Notes', 'Create and organise notes; save useful AI answers for later.'],
                    ['Quizzes and worksheets', 'Generate practice on a topic and review your answers.'],
                    ['Flashcards', 'Build and revisit question-and-answer cards for revision.'],
                    ['AI Creative', 'Explore the writing and creative activities in your workspace.'],
                    ['Summaries and diagrams', 'Turn material into shorter explanations and visual study aids.'],
                    ['Interactive learning labs', 'Explore the simulations available in the learning workspace.'],
                    ['Focus tools', 'Use the focus timer to structure study sessions.'],
                    ['Personal progress', 'View your activity, study progress and practice results.'],
                    ['Leaderboard', 'See the learning activity rankings available in the app.'],
                    ['Existing classroom materials', 'Access shared work and resources from classrooms you are enrolled in. Teacher authoring has been retired.'],
                    ['Favourites and search', 'Find a tool quickly and keep useful tools close.'],
                    ['Consistent tool workspace', 'Write a brief, generate a result, then copy, save, listen or export.'],
                    ...common.slice(1).map(name => [name, 'Use the same calm workspace across supported devices.'])
                ]}
            ]
        },
        developer: {
            name: 'Developer Plus', price: 1999, eyebrow: 'FOR WHAT YOU WILL BUILD NEXT',
            description: 'A focused workspace for technical practice and better code.',
            highlights: ['Technical mock tests with a timer', 'AI code review and improvement suggestions', 'Technical notes and architecture guides', 'Interview preparation by skill and level', 'Personal skills and activity tracking', 'Automatic model selection for every AI task'],
            groups: [
                { name: 'Technical practice', items: [
                    ['Personal skills', 'Add and organise the technologies you want to practise.'],
                    ['Technical mock tests', 'Choose a stack, level and question count for a timed practice session.'],
                    ['Multiple skill areas', 'Practise JavaScript, React, Node.js, Python, SQL, cloud concepts and data structures.'],
                    ['Seniority levels', 'Choose junior, intermediate or senior practice.'],
                    ['AI feedback', 'Review provisional scores and explanations after submission. These are not certifications.'],
                    ['Retake practice', 'Start another session to revisit what you found difficult.']
                ]},
                { name: 'Code and technical knowledge', items: [
                    ['AI code review', 'Paste source code for suggestions on correctness, clarity and design.'],
                    ['Security observations', 'Get potential risks to investigate. AI review does not replace security testing.'],
                    ['Performance analysis', 'Ask for complexity and performance considerations.'],
                    ['Refactoring suggestions', 'See suggested changes and example code to review and test.'],
                    ['Language choices', 'Review JavaScript / TypeScript, Python, Java, Go / Rust and SQL.'],
                    ['Technical notes', 'Generate focused notes for a technical topic.'],
                    ['Architecture guides', 'Explore design concepts, code examples and trade-offs.'],
                    ['Interview cheat sheets', 'Prepare topic summaries and interview questions.'],
                    ['Anti-pattern guides', 'Learn about common design mistakes and possible fixes.'],
                    ['Save to notes', 'Keep a generated technical guide in My Notes.']
                ]},
                { name: 'One focused workspace', items: [
                    ['Project review history', 'Revisit the local history of your code reviews and practice.'],
                    ['Skills and progress', 'Track activity in this browser. Local progress is not a verified professional credential.'],
                    ['Tool search', 'Jump to tests, notes and code review.'],
                    ['Automatic model selection', 'Detailed technical tasks use stronger models; available providers can act as backups.'],
                    ...common.slice(1).map(name => [name, 'The same restrained blue and white design, with dark mode available.'])
                ]}
            ]
        }
    };
})();
