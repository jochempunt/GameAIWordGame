
export const adjectives = [
    "Mighty",
    "Sleepy",
    "Wobbly",
    "Cosmic",
    "Funny",
    "Tiny",
    "Chaotic",
    "Fabulous",
    "Bouncy",
    "Goofy",
    "Mysterious",
    "Sparkly",
    "Fluffy",
    "Dizzy",
    "Jolly",
    "Cheesy",
    "Wiggly",
    "Majestic",
    "Clumsy",
    "Magical",
];

export const nouns = [
    "Turnip",
    "Pickle",
    "Wizard",
    "Potato",
    "Penguin",
    "Noodle",
    "Pancake",
    "Goblin",
    "Waffle",
    "Dinosaur",
    "Muffin",
    "Octopus",
    "Pigeon",
    "Toaster",
    "Unicorn",
    "Meatball",
    "Cactus",
    "Hamster",
    "Burrito",
    "Duck",
];

export function generatePlayerName(usedNames: Set<string>): string {
    const availableNames: string[] = [];

    for (const adjective of adjectives) {
        for (const noun of nouns) {
            const name = `${adjective} ${noun}`;

            if (!usedNames.has(name.toLowerCase())) {
                availableNames.push(name);
            }
        }
    }

    if (availableNames.length === 0) {
        throw new Error("No unique player names available");
    }

    const index = Math.floor(Math.random() * availableNames.length);
    return availableNames[index];
}
