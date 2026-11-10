import { redisName } from '../events/event-bus.js';

/** BullMQ keys become `<APP_ENV>:email:*`; validated like the event helpers do. */
export function queuePrefix(appEnv: string): string {
  redisName(appEnv, 'email');
  return appEnv;
}
