import { UPLOAD_BATCH_SIZE, uploadMeasurements } from './upload';
import type { Measurement, Mode } from './types';

export type LiveUploadStatus = { sent: number; pending: number; error: string | null };

export class LiveUpload {
  private queue: Measurement[] = [];
  private active = false;
  private inFlight = 0;
  private sent = 0;
  private error: string | null = null;
  private closed = false;
  private finishing = false;
  private partialReady = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
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

  // 最終保存が終わったら、30件未満の端数も待たずに送る。
  finish() { this.finishing = true; this.pump(); }

  close() {
    this.closed = true;
    this.queue = [];
    clearTimeout(this.timer);
    this.controller.abort();
  }

  private publish() {
    if (!this.closed) this.onStatus({ sent: this.sent, pending: this.queue.length + this.inFlight, error: this.error });
  }

  private pump() {
    if (this.closed || this.error) return;
    if (!this.active && this.queue.length && (this.queue.length >= UPLOAD_BATCH_SIZE || this.partialReady || this.finishing)) {
      const batch = this.queue.splice(0, UPLOAD_BATCH_SIZE);
      clearTimeout(this.timer); this.timer = undefined; this.partialReady = false;
      this.active = true; this.inFlight = batch.length;
      void uploadMeasurements(this.endpoint, batch, this.mode, {
        signal: this.controller.signal, sentIds: new Set(),
        onSent: async id => {
          await this.onSent(id);
          this.sent++; this.inFlight--; this.publish();
        },
        onProgress: () => {},
      }).catch(error => {
        this.error = error instanceof Error ? error.message : '送信に失敗しました。';
        this.queue = [];
        clearTimeout(this.timer); this.timer = undefined;
      }).finally(() => {
        this.active = false; this.inFlight = 0;
        this.pump(); this.publish();
      });
    }
    if (this.queue.length && !this.timer && !this.partialReady && !this.finishing) {
      this.timer = setTimeout(() => {
        this.timer = undefined; this.partialReady = true; this.pump();
      }, 1000);
    }
    this.publish();
  }
}
