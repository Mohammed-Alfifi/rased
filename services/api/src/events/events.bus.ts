import { Injectable } from '@nestjs/common';
import { Subject } from 'rxjs';

export interface BusMessage {
  kind: 'event.created' | 'event.reviewed' | 'camera.status';
  data: Record<string, unknown>;
}

/** In-process fan-out to the command centre's live stream (server-sent events). */
@Injectable()
export class EventsBus {
  readonly stream = new Subject<BusMessage>();

  publish(msg: BusMessage) {
    this.stream.next(msg);
  }
}
