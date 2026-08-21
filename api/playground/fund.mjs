/**
 * POST /playground/fund — Vercel binding for the playground faucet.
 *
 * The handler itself lives in apps/facilitator/src/faucet.mjs, mounted identically on the
 * local facilitator at :4021, so the guards a visitor meets in the browser playground are
 * the same ones a developer meets running the stack locally.
 */

import { createFaucetHandler } from '../../apps/facilitator/src/faucet.mjs';

export default createFaucetHandler();
