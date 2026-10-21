type Answer = { id: string; words: string[] };
type RankingElements = {
    instructions: HTMLElement;
    choices: HTMLUListElement;
    ranked: HTMLOListElement;
    progress: HTMLElement;
    choicesSection: HTMLElement;
    undo: HTMLButtonElement;
    submit: HTMLButtonElement;
};

/** Each position requires a deliberate choice; incoming state updates keep that draft. */
export class RankingPicker {
    private answers = new Map<string, Answer>();
    private order: string[] = [];
    private submitting = false;
    private selectedId: string | null = null;

    constructor(private elements: RankingElements) {
        elements.undo.addEventListener("click", () => {
            if (this.submitting) return;
            this.selectedId = null;
            this.order.pop();
            this.render();
            this.focusNextChoice();
        });

    }

    get complete(): boolean { return this.answers.size > 0 && this.order.length === this.answers.size; }
    get canSubmit(): boolean { return this.complete && !this.submitting; }
    get answerIds(): string[] { return [...this.order]; }

    reset(answers: Answer[] = []): void {
        this.order = [];
        this.selectedId = null;
        this.submitting = false;
        this.update(answers);
    }

    update(answers: Answer[]): void {
        this.answers = new Map(answers.map(answer => [answer.id, answer]));
        this.order = this.order.filter(id => this.answers.has(id));
        if (this.selectedId && !this.order.includes(this.selectedId)) this.selectedId = null;
        this.render();
    }

    setSubmitting(submitting: boolean): void {
        this.submitting = submitting;
        this.render();
    }

    private focusNextChoice(): void {
        const next = this.elements.choices.querySelector("button") ?? this.elements.submit;
        next.focus({ preventScroll: true });
    }

    private render(animateSwap = false): void {
        const { choices, ranked, progress, choicesSection, undo, submit, instructions } = this.elements;
        const oldPositions = new Map<string, number>();
        if (animateSwap && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            for (const button of ranked.querySelectorAll<HTMLButtonElement>(".ranking-placed-button")) {
                oldPositions.set(button.dataset.answerId!, button.getBoundingClientRect().top);
            }
        }
        instructions.textContent = this.selectedId
            ? "Tap another ranked answer to swap. Tap the selected answer again to cancel."
            : "Tap answers to rank, funniest first. Tap two placed answers to swap.";
        const total = this.answers.size;
        const colors = new Map([...this.answers.keys()].map((id, index) => [id, `hsl(${(40 + index * 137.508) % 360} 75% 78%)`]));
        progress.textContent = `${this.order.length} / ${total}`;
        choicesSection.hidden = this.complete;
        choices.replaceChildren();
        for (const answer of this.answers.values()) {
            if (this.order.includes(answer.id)) continue;
            const item = document.createElement("li");
            const button = document.createElement("button");
            button.type = "button";
            button.className = "ranking-choice";
            button.dataset.answerId = answer.id;
            button.disabled = this.submitting;
            const text = document.createElement("span");
            text.className = "ranking-answer-text";
            text.textContent = answer.words.join(" ");
            const dot = document.createElement("span");
            dot.className = "ranking-answer-dot";
            dot.setAttribute("aria-hidden", "true");
            button.append(dot, text);
            button.setAttribute("aria-label", `Place at rank ${this.order.length + 1}: ${answer.words.join(" ")}`);
            button.addEventListener("click", () => {
                if (this.submitting || this.order.includes(answer.id)) return;
                this.selectedId = null;
                this.order.push(answer.id);
                this.render();
                this.focusNextChoice();
            });
            item.append(button);
            choices.append(item);
        }
        ranked.replaceChildren();
        if (!this.order.length) {
            const empty = document.createElement("li");
            empty.className = "ranking-empty";
            empty.textContent = "Tap an answer below to begin.";
            ranked.append(empty);
        }
        this.order.forEach((id, index) => {
            const item = document.createElement("li");
            item.className = "ranking-placed";
            item.value = index + 1;
            const button = document.createElement("button");
            button.type = "button";
            button.className = "ranking-placed-button";
            button.dataset.answerId = id;
            button.disabled = this.submitting;
            button.setAttribute("aria-pressed", String(this.selectedId === id));
            const action = this.selectedId === id ? "Selected. Tap again to cancel."
                : this.selectedId ? "Tap to swap with the selected answer." : "Select to swap.";
            button.setAttribute("aria-label", `Rank ${index + 1}: ${this.answers.get(id)!.words.join(" ")}. ${action}`);
            const position = document.createElement("span");
            position.className = "ranking-position";
            position.style.background = colors.get(id)!;
            position.textContent = String(index + 1);
            const text = document.createElement("span");
            text.className = "ranking-answer-text";
            text.textContent = this.answers.get(id)!.words.join(" ");
            button.append(position, text);
            button.addEventListener("click", () => {
                if (this.submitting) return;
                let swapped = false;
                if (this.selectedId && this.selectedId !== id) {
                    const from = this.order.indexOf(this.selectedId);
                    const to = this.order.indexOf(id);
                    [this.order[from], this.order[to]] = [this.order[to], this.order[from]];
                    this.selectedId = null;
                    swapped = true;
                } else {
                    this.selectedId = this.selectedId === id ? null : id;
                }
                this.render(swapped);
                this.elements.ranked.querySelector<HTMLButtonElement>(`[data-answer-id="${id}"]`)?.focus({ preventScroll: true });
            });
            item.append(button);
            ranked.append(item);
        });
        for (const button of ranked.querySelectorAll<HTMLButtonElement>(".ranking-placed-button")) {
            const previousTop = oldPositions.get(button.dataset.answerId!);
            if (previousTop === undefined) continue;
            const offset = previousTop - button.getBoundingClientRect().top;
            if (Math.abs(offset) > 1) {
                button.animate([
                    { transform: `translateY(${offset}px)` },
                    { transform: "translateY(0)" },
                ], { duration: 220, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
            }
        }
        undo.disabled = this.submitting || this.order.length === 0;
        submit.disabled = !this.canSubmit;
        submit.textContent = this.submitting ? "Submitting…" : "Submit ranking";
    }
}
