import { uploadMeasurements } from './upload';
import type { Measurement, Mode } from './types';

export type LiveUploadStatus = { sent: number; pending: number; error: string | null };

// センサのコールバックを通信待ちで止めず、同時リクエスト数を制限する。
export class LiveUpload {
  private queue: Measurement[] = [];
  private active = 0;
  private sent = 0;
  private error: string | null = null;
  private closed = false;
  private controller = new AbortController();

  constructor(
    private endpoint: string,
    private mode: Mode,
    private onSent: (id: string) => Promise<void>,
    private onStatus: (status: LiveUploadStatus) => void,
  ) {}

  enqueue(items: Measurement[]) {
    if (this.closed || this.error) return;
    this.queue.push(...items);
    this.pump();
  }

  close() {
    this.closed = true;
    this.queue = [];
    this.controller.abort();
  }

  private publish() {
    if (!this.closed) this.onStatus({ sent: this.sent, pending: this.queue.length + this.active, error: this.error });
  }

  private pump() {
    while (!this.closed && !this.error && this.active < 6 && this.queue.length) {
      const item = this.queue.shift()!;
      this.active++;
      void uploadMeasurements(this.endpoint, [item], this.mode, {
        signal: this.controller.signal, sentIds: new Set(),
        onSent: this.onSent, onProgress: () => {},
      }).then(() => { this.sent++; }).catch(error => {
        this.error ??= error instanceof Error ? error.message : '送信に失敗しました。';
        this.queue = [];
      }).finally(() => {
        this.active--;
        this.pump();
      });
    }
    this.publish();
  }
}
