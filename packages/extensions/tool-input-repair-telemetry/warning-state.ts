export class RepeatedWarningGate {
  #lastMessage?: string;

  shouldNotify(message: string): boolean {
    if (message === this.#lastMessage) return false;
    this.#lastMessage = message;
    return true;
  }

  recordSuccess(): void {
    this.#lastMessage = undefined;
  }
}
