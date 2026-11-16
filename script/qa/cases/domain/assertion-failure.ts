import type { QaCase } from '../../lib/contracts';
export const run: QaCase = async context => {
  context.assert(false, 'Intentional harness assertion failure');
};
