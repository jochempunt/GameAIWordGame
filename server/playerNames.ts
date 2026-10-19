
export const adjectives = [
    "Mighty",
    "Sleepy",
    "Cosmic",
    "Funny",
    "Tiny",
    "Chaotic",
    "Fabulous",
    "Goofy",
    "Mysterious",
    "Sparkly",
    "Fluffy",
    "Dizzy",
    "Jolly",
    "Cheesy",
    "Wise",
    "Fantastic",
    "Majestic",
    "Clumsy",
    "Magical",
];

export const nouns = [
    "Turnip",
    "Wizard",
    "Potato",
    "Penguin",
    "Noodle",
    "Pancake",
    "Goblin",
    "Waffle",
    "Raccoon",
    "Cat",
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

    if (availableNames.length > 0) {
        const index = Math.floor(Math.random() * availableNames.length);
        return availableNames[index];
    }

    // Every plain name is taken: add a number, e.g. "Sleepy Penguin 2".
    const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];
    for (let suffix = 2; ; suffix++) {
        const name = `${adjective} ${noun} ${suffix}`;

        if (!usedNames.has(name.toLowerCase())) {
            return name;
        }
    }
}
