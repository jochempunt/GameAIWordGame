export const EMOTES = [
    {
        id: "greeting",
        icon: "👋",
        label: "Greeting",
        messages: ["Howdy", "Hey y'all", "Hello!", "Greetings.", "G'day mate!", "Wassup?", "Hi!", "Hewwo UwU"],
    },
    {
        id: "readiness",
        icon: "✅",
        label: "Ready",
        messages: ["Ready when you are!", "Let's go!", "Bring it on!", "I'm ready!", "Locked and loaded!"],
    },
    {
        id: "impatience",
        icon: "⏳",
        label: "Hurry up",
        messages: ["Hurry up!", "Hello?", "I'm waiting...", "*crickets chirping*", "I'm getting old here!", "Any day now..."],
    },
    {
        id: "boasting",
        icon: "🔥",
        label: "Boast",
        messages: ["I cooked", "EZ no diff", "Certified classic", "Absolute banger", "No crumbs", "Chicken dinner!", "Flawless victory", "Shots fired!"],
    },
    {
        id: "regret",
        icon: "😩",
        label: "Regret",
        messages: ["Fumbled so hard", "Whiffed it", "Swing-and-a-miss", "I regret everything...", "Don't judge me", "Sounded better in my head"],
    },
    {
        id: "disbelief",
        icon: "🤯",
        label: "Disbelief",
        messages: ["No words.", "WHAT!?", "I have no words", "I'm speechless...", "Um, what?", "I have questions."],
    },
    {
        id: "praise",
        icon: "👏",
        label: "Praise",
        messages: ["GG", "Good one", "Well played", "Good Game", "GGWP", "Good stuff", "Nice one"],
    },
] as const;

export type EmoteId = typeof EMOTES[number]["id"];

export function findEmote(id: unknown) {
    return typeof id === "string" ? EMOTES.find(emote => emote.id === id) : undefined;
}