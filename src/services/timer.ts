export class Timer<R = any> {
  private callback: () => R | Promise<R>;
  private delay: number;
  private timerHalted: boolean = false;
  private timerId: ReturnType<typeof setTimeout> | null = null;

  constructor(callback: () => R | Promise<R>, delay: number) {
    this.callback = callback;
    this.delay = delay;
  }

  startTimer(): void {
    if (this.timerHalted) {
      console.log(`[Timer] Timer halted - not starting`);
      return;
    }

    console.log(
      `[Timer] Starting timer: ${this.delay}ms (current: ${this.timerId})`
    );
    this.stopTimer();

    this.timerId = setTimeout(() => {
      Promise.resolve(this.callback());
    }, this.delay);
  }

  stopTimer(): void {
    if (this.timerId !== null) {
      console.log(`[Timer] Stopping timer: ${this.timerId}`);
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }

  haltTimer(): void {
    console.log(
      `[Timer] Halting timer (halted: ${this.timerHalted}, id: ${this.timerId})`
    );
    this.timerHalted = true;
    this.stopTimer();
  }

  resumeTimer(): void {
    console.log(`[Timer] Resuming timer (halted: ${this.timerHalted})`);
    this.timerHalted = false;
    this.stopTimer();
  }
}
