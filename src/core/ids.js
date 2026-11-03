import { randomBytes } from 'node:crypto';

export const uid = (prefix) => `${prefix}_${randomBytes(5).toString('hex')}`;
