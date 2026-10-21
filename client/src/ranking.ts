import { RankingDrag } from "./rankingDrag.js";

type Answer = { id: string; words: string[] };
type RankingElements = {
    instructions: HTMLElement;
    choices: HTMLUListElement;
    ranked: HTMLOListElement;
    progress: HTMLElement;
    choicesSection: HTMLElement;
    submit: HTMLButtonElement;
};

/** Tap or drag to place/remove/reorder. Incoming room updates preserve the draft. */
export class RankingPicker {
    private answers = new Map<string, Answer>();
    private order: string[] = [];
    private submitting = false;
    private drag: RankingDrag;
    private previousInstructionMinHeight: string | null = null;

    constructor(private elements: RankingElements) {
        this.drag = new RankingDrag({
            root: elements.ranked.closest<HTMLElement>("#ranking-view")!,
            ranked: elements.ranked,
            choices: elements.choices,
            choicesTarget: elements.choicesSection,
            target: elements.ranked.closest<HTMLElement>(".ranking-draft")!,
            allowed: () => !this.submitting,
            busy: () => {
                // Live drag instructions must not move the drop zone under the finger.
                this.previousInstructionMinHeight = elements.instructions.style.minHeight;
                elements.instructions.style.minHeight = `${elements.instructions.getBoundingClientRect().height}px`;
                elements.submit.disabled = true;
            },
            status: message => { elements.instructions.textContent = message; },
            drop: (id, index, keyboard = false) => {
                if (!this.answers.has(id)) return;
                this.order = this.order.filter(answerId => answerId !== id);
                this.order.splice(index, 0, id);
                this.render();
                if (keyboard) {
                    [...elements.ranked.querySelectorAll<HTMLButtonElement>(".ranking-drag-handle")]
                        .find(handle => handle.dataset.answerId === id)?.focus({ preventScroll: true });
                }
            },
            remove: id => {
                this.order = this.order.filter(answerId => answerId !== id);
                this.render();
                this.focusChoice(id);
            },
            cancel: () => this.render(),
        });
    }

    get complete(): boolean { return this.answers.size > 0 && this.order.length === this.answers.size; }
    get canSubmit(): boolean { return this.complete && !this.submitting && !this.drag.active; }
    get answerIds(): string[] { return [...this.order]; }

    reset(answers: Answer[] = []): void {
        this.drag.cancel(false);
        this.order = [];
        this.submitting = false;
        this.update(answers);
    }

    update(answers: Answer[]): void {
        if (this.drag.active) {
            const unchanged = answers.length === this.answers.size && answers.every(answer =>
                JSON.stringify(this.answers.get(answer.id)?.words) === JSON.stringify(answer.words));
            if (unchanged) return;
            this.drag.cancel(false);
        }
        this.answers = new Map(answers.map(answer => [answer.id, answer]));
        this.order = this.order.filter(id => this.answers.has(id));
        this.render();
    }

    setSubmitting(submitting: boolean): void {
        this.drag.cancel(false);
        this.submitting = submitting;
        this.render();
    }

    private focusChoice(id?: string): void {
        const buttons = [...this.elements.choices.querySelectorAll<HTMLButtonElement>(".ranking-choice:not(:disabled)")];
        (buttons.find(button => button.dataset.answerId === id) ?? buttons[0] ?? this.elements.submit)
            .focus({ preventScroll: true });
    }

    private handle(id: string): HTMLButtonElement {
        const handle = document.createElement("button");
        handle.type = "button";
        handle.className = "ranking-drag-handle";
        handle.dataset.answerId = id;
        handle.disabled = this.submitting;
        handle.setAttribute("aria-label", `Move ${this.answers.get(id)!.words.join(" ")}. Drag or use the Up and Down arrow keys to reorder.`);
        return handle;
    }

    private render(): void {
        const { choices, ranked, progress, choicesSection, submit, instructions } = this.elements;
        if (!this.drag.active && this.previousInstructionMinHeight !== null) {
            instructions.style.minHeight = this.previousInstructionMinHeight;
            this.previousInstructionMinHeight = null;
        }
        instructions.textContent = "Rank the answers from funniest to least funny. Tap to add or remove; hold and drag to place or reorder.";
        const colors = new Map([...this.answers.keys()].map((id, index) => [id, `hsl(${(40 + index * 137.508) % 360} 80% 65%)`]));
        progress.textContent = `${this.order.length} / ${this.answers.size}`;
        choicesSection.hidden = false;
        choices.replaceChildren();
        for (const answer of this.answers.values()) {
            if (this.order.includes(answer.id)) continue;
            const item = document.createElement("li");
            item.dataset.answerId = answer.id;
            const row = document.createElement("div");
            row.className = "ranking-answer-row";
            const button = document.createElement("button");
            button.type = "button";
            button.className = "ranking-choice";
            button.dataset.answerId = answer.id;
            button.disabled = this.submitting;
            button.setAttribute("aria-pressed", "false");
            const selection = document.createElement("span");
            selection.className = "ranking-selection-circle";
            selection.setAttribute("aria-hidden", "true");
            const text = document.createElement("span");
            text.className = "ranking-answer-text";
            text.textContent = answer.words.join(" ");
            button.append(selection, text);
            button.setAttribute("aria-label", `Place at rank ${this.order.length + 1}: ${answer.words.join(" ")}`);
            button.addEventListener("click", () => {
                if (this.submitting || this.drag.active || this.order.includes(answer.id)) return;
                this.order.push(answer.id);
                this.render();
                this.focusChoice();
            });
            row.append(button);
            item.append(row);
            choices.append(item);
        }
        if (this.complete) {
            const empty = document.createElement("li");
            empty.className = "ranking-answers-empty";
            empty.textContent = "All answers placed.";
            choices.append(empty);
        }
        ranked.replaceChildren();
        if (!this.order.length) {
            const empty = document.createElement("li");
            empty.className = "ranking-empty";
            empty.textContent = "Tap or drag an answer here to begin.";
            ranked.append(empty);
        }
        this.order.forEach((id, index) => {
            const item = document.createElement("li");
            item.className = "ranking-placed";
            item.value = index + 1;
            item.dataset.answerId = id;
            const row = document.createElement("div");
            row.className = "ranking-answer-row";
            const button = document.createElement("button");
            button.type = "button";
            button.className = "ranking-placed-button";
            button.dataset.answerId = id;
            button.disabled = this.submitting;
            button.setAttribute("aria-pressed", "true");
            button.setAttribute("aria-label", `Rank ${index + 1}: ${this.answers.get(id)!.words.join(" ")}. Tap to remove from ranking.`);
            const position = document.createElement("span");
            position.className = "ranking-selection-circle ranking-position";
            position.style.background = colors.get(id)!;
            position.textContent = String(index + 1);
            const text = document.createElement("span");
            text.className = "ranking-answer-text";
            text.textContent = this.answers.get(id)!.words.join(" ");
            button.append(position, text);
            button.addEventListener("click", () => {
                if (this.submitting || this.drag.active) return;
                this.order = this.order.filter(answerId => answerId !== id);
                this.render();
                this.focusChoice(id);
            });
            row.append(button, this.handle(id));
            item.append(row);
            ranked.append(item);
        });
        submit.disabled = !this.canSubmit;
        submit.textContent = this.submitting ? "Submitting…" : "Submit ranking";
    }
}
