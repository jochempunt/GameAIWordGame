type DragOptions = {
    root: HTMLElement;
    ranked: HTMLOListElement;
    target: HTMLElement;
    choices: HTMLUListElement;
    choicesTarget: HTMLElement;
    allowed: () => boolean;
    busy: () => void;
    status: (message: string) => void;
    drop: (id: string, position: number, keyboard?: boolean) => void;
    remove: (id: string) => void;
    cancel: () => void;
};

type Drag = {
    tapTarget: HTMLButtonElement | null; pointer: number; id: string; source: HTMLLIElement; row: HTMLElement;
    x: number; y: number; startX: number; startY: number; offsetX: number; offsetY: number;
    touch: boolean; scrolling: boolean; hold: ReturnType<typeof setTimeout> | null;
    fromRanked: boolean; originalChoicesMinHeight: string; originalVisibility: string;
    lifted: boolean; originalMinHeight: string; ghost: HTMLElement | null;
};

/** Whole-card dragging: hold on touch, move on mouse; quick touch swipes scroll. */
export class RankingDrag {
    private drag: Drag | null = null;
    private pan: { pointer: number; y: number } | null = null;
    private slot = document.createElement("li");
    private frame: number | undefined;
    private suppressClick = false;
    private lastPosition = -1;
    private removing = false;

    constructor(private options: DragOptions) {
        this.slot.className = "ranking-drop-slot";
        this.slot.textContent = "Drop here";
        this.slot.setAttribute("aria-hidden", "true");
        options.root.addEventListener("pointerdown", event => {
            // A new gesture clears the previous one. Gaps in the ranking must not
            // let mobile click targeting select a neighbouring card, either.
            this.suppressClick = options.target.contains(event.target as Node) || options.choicesTarget.contains(event.target as Node);
            this.start(event);
        });
        document.addEventListener("pointermove", event => this.move(event), { passive: false });
        document.addEventListener("pointerup", event => this.end(event));
        document.addEventListener("pointercancel", event => {
            if (event.pointerId === this.pan?.pointer) this.pan = null;
            if (event.pointerId === this.drag?.pointer) this.cancel();
        });
        options.root.addEventListener("lostpointercapture", event => {
            if (event.pointerId === this.pan?.pointer) this.pan = null;
            if (event.pointerId === this.drag?.pointer) this.cancel();
        });
        options.root.addEventListener("click", event => {
            // Pointer clicks can arrive late, after removing a card changed the layout.
            // Keyboard activation and our explicit button.click() have detail === 0.
            if (this.suppressClick && event.detail > 0) { event.preventDefault(); event.stopImmediatePropagation(); }
        }, true);
        options.root.addEventListener("keydown", event => this.key(event));
        document.addEventListener("visibilitychange", () => { if (document.hidden) this.cancel(); });
        window.addEventListener("blur", () => this.cancel());
        window.addEventListener("resize", () => this.cancel());
        new MutationObserver(() => { if (options.root.hidden) this.cancel(); })
            .observe(options.root, { attributes: true, attributeFilter: ["hidden"] });
    }

    get active(): boolean { return this.drag !== null; }

    cancel(notify = true): void {
        this.pan = null;
        if (!this.drag) return;
        this.cleanup();
        if (notify) this.options.cancel();
    }

    private start(event: PointerEvent): void {
        const physicalTarget = document.elementFromPoint(event.clientX, event.clientY);
        const rowTarget = physicalTarget?.closest<HTMLElement>(".ranking-answer-row");
        if (!rowTarget && physicalTarget && event.pointerType === "touch" && event.isPrimary &&
            (this.options.target.contains(physicalTarget) || this.options.choicesTarget.contains(physicalTarget))) {
            // A browser may aim a gap touch at a nearby card with touch-action:none.
            // Preserve scrolling without interpreting that touch as card selection.
            this.pan = { pointer: event.pointerId, y: event.clientY };
            event.preventDefault();
            this.options.root.setPointerCapture(event.pointerId);
            return;
        }
        if (!rowTarget || (!this.options.ranked.contains(rowTarget) && !this.options.choices.contains(rowTarget)) || !event.isPrimary || event.button !== 0 || this.drag || !this.options.allowed()) return;
        const rect = rowTarget.getBoundingClientRect();
        // Mobile browsers can expand a button's touch target into the gap.
        // Only treat a touch physically inside this card as a card gesture.
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return;
        event.preventDefault();
        const source = rowTarget.closest<HTMLLIElement>("li[data-answer-id]")!;
        const row = source.querySelector<HTMLElement>(".ranking-answer-row")!;
        this.drag = {
            tapTarget: physicalTarget!.closest<HTMLButtonElement>(".ranking-placed-button, .ranking-choice"),
            pointer: event.pointerId, id: source.dataset.answerId!, source, row,
            x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY,
            offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top,
            touch: event.pointerType === "touch", scrolling: false, hold: null,
            fromRanked: this.options.ranked.contains(source),
            originalChoicesMinHeight: this.options.choices.style.minHeight,
            originalVisibility: row.style.visibility,
            lifted: false,
            originalMinHeight: this.options.ranked.style.minHeight, ghost: null,
        };
        this.lastPosition = -1;
        // Capture before hiding a source card, including when dragging its text.
        this.options.root.setPointerCapture(event.pointerId);
        if (this.drag.touch) {
            this.drag.hold = setTimeout(() => {
                if (this.drag && !this.drag.scrolling) this.lift();
            }, 220);
        }
    }

    private move(event: PointerEvent): void {
        if (this.pan?.pointer === event.pointerId) {
            event.preventDefault();
            window.scrollBy(0, this.pan.y - event.clientY);
            this.pan.y = event.clientY;
            return;
        }
        const drag = this.drag;
        if (!drag || event.pointerId !== drag.pointer) return;
        event.preventDefault();
        const previousY = drag.y;
        drag.x = event.clientX; drag.y = event.clientY;
        if (!drag.lifted && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) >= 8) {
            if (drag.touch) {
                if (drag.hold !== null) clearTimeout(drag.hold);
                drag.scrolling = true;
            } else this.lift();
        }
        if (drag.scrolling) window.scrollBy(0, previousY - drag.y);
        if (drag.lifted) this.position();
    }

    private lift(): void {
        const drag = this.drag!;
        drag.lifted = true;
        this.options.busy();
        const rect = drag.row.getBoundingClientRect();
        drag.row.getAnimations().forEach(animation => animation.cancel());
        const ghost = drag.row.cloneNode(true) as HTMLElement;
        ghost.classList.add("ranking-drag-preview");
        ghost.setAttribute("aria-hidden", "true");
        ghost.style.width = `${rect.width}px`;
        document.body.append(ghost);
        drag.ghost = ghost;
        this.slot.style.height = `${rect.height}px`;
        this.options.ranked.style.minHeight = `${Math.max(58, this.options.ranked.getBoundingClientRect().height)}px`;
        this.options.choices.style.minHeight = `${this.options.choices.getBoundingClientRect().height}px`;
        if (drag.fromRanked) drag.source.before(this.slot);
        if (drag.fromRanked) drag.source.hidden = true;
        // Keep the stash slot's dimensions, but show only the floating card.
        if (!drag.fromRanked) drag.row.style.visibility = "hidden";
        this.options.root.classList.add("ranking-is-dragging");
        this.position();
        this.scroll();
    }

    private position(): void {
        const drag = this.drag!;
        drag.ghost!.style.transform = `translate3d(${drag.x - drag.offsetX}px, ${drag.y - drag.offsetY}px, 0) rotate(1.5deg) scale(1.02)`;
        const rect = this.options.target.getBoundingClientRect();
        const choicesRect = this.options.choicesTarget.getBoundingClientRect();
        const overChoices = drag.x >= choicesRect.left && drag.x <= choicesRect.right && drag.y >= choicesRect.top && drag.y <= choicesRect.bottom;
        this.removing = drag.fromRanked && overChoices;
        this.options.choicesTarget.classList.toggle("ranking-remove-active", this.removing);
        const over = !overChoices && drag.x >= rect.left - 16 && drag.x <= rect.right + 16 && drag.y >= rect.top - 20 && drag.y <= rect.bottom + 12;
        this.options.target.classList.toggle("ranking-drop-active", over);
        const empty = this.options.ranked.querySelector<HTMLElement>(".ranking-empty");
        if (empty) empty.hidden = over;
        if (!over) {
            this.slot.remove(); this.lastPosition = -1;
            this.options.status(this.removing ? "Release to return this answer to Answers." : "Drop in your ranking to place, or in Answers to remove.");
            return;
        }
        const others = [...this.options.ranked.querySelectorAll<HTMLLIElement>("li[data-answer-id]")]
            .filter(item => !item.hidden);
        const target = others.find(item => {
            const box = item.getBoundingClientRect();
            return drag.y < box.top + box.height / 2;
        });
        const position = target ? others.indexOf(target) : others.length;
        if (position !== this.lastPosition || !this.slot.isConnected) {
            this.options.ranked.insertBefore(this.slot, target ?? null);
            this.lastPosition = position;
            this.options.status(`Release to place at #${position + 1}.`);
        }
    }

    private scroll = (): void => {
        if (!this.drag?.lifted) return;
        const y = this.drag.y;
        const speed = y < 80 ? -Math.min(14, (80 - y) / 5)
            : y > window.innerHeight - 80 ? Math.min(14, (y - window.innerHeight + 80) / 5) : 0;
        if (speed) { window.scrollBy(0, speed); this.position(); }
        this.frame = requestAnimationFrame(this.scroll);
    };

    private end(event: PointerEvent): void {
        if (this.pan?.pointer === event.pointerId) { this.pan = null; return; }
        const drag = this.drag;
        if (!drag || drag.pointer !== event.pointerId) return;
        if (drag.lifted) {
            drag.x = event.clientX; drag.y = event.clientY;
            this.position();
        }
        const position = this.slot.isConnected ? this.lastPosition : -1;
        const id = drag.id;
        const lifted = drag.lifted;
        const removing = this.removing;
        this.cleanup();
        if (!lifted) {
            if (!drag.scrolling && drag.tapTarget) {
                // Capture targets the section; forward an actual tap to its original button.
                drag.tapTarget.click();
            }
            return;
        }
        if (removing) this.options.remove(id);
        else if (position >= 0) this.options.drop(id, position);
        else this.options.cancel();
    }

    private cleanup(): void {
        const drag = this.drag!;
        this.drag = null;
        if (drag.hold !== null) clearTimeout(drag.hold);
        if (this.frame !== undefined) cancelAnimationFrame(this.frame);
        this.frame = undefined;
        drag.ghost?.remove();
        drag.source.hidden = false;
        drag.row.style.visibility = drag.originalVisibility;
        this.slot.remove();
        this.options.ranked.style.minHeight = drag.originalMinHeight;
        this.options.choices.style.minHeight = drag.originalChoicesMinHeight;
        this.options.choicesTarget.classList.remove("ranking-remove-active");
        this.removing = false;
        this.options.ranked.querySelector<HTMLElement>(".ranking-empty")?.removeAttribute("hidden");
        this.options.root.classList.remove("ranking-is-dragging");
        this.options.target.classList.remove("ranking-drop-active");
        if (this.options.root.hasPointerCapture(drag.pointer)) this.options.root.releasePointerCapture(drag.pointer);
        this.suppressClick = true;
    }

    private key(event: KeyboardEvent): void {
        if (event.key === "Escape" && this.active) { event.preventDefault(); this.cancel(); return; }
        const handle = (event.target as Element).closest<HTMLButtonElement>(".ranking-drag-handle");
        if (!handle || !this.options.ranked.contains(handle) || handle.disabled || this.active || !this.options.allowed()) return;
        const id = handle.closest<HTMLLIElement>("li[data-answer-id]")!.dataset.answerId!;
        const order = [...this.options.ranked.querySelectorAll<HTMLLIElement>("li[data-answer-id]")].map(item => item.dataset.answerId!);
        const index = order.indexOf(id);
        let target: number | undefined;
        if (index >= 0 && event.key === "ArrowUp") target = Math.max(0, index - 1);
        if (index >= 0 && event.key === "ArrowDown") target = Math.min(order.length - 1, index + 1);
        if (index >= 0 && event.key === "Home") target = 0;
        if (index >= 0 && event.key === "End") target = order.length - 1;
        if (event.key === "Escape") { this.cancel(); return; }
        if (target === undefined) return;
        event.preventDefault();
        this.options.drop(id, target, true);
    }
}
