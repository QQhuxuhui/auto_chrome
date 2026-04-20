/**
 * Pure decision function for stage 2 member outcomes.
 *
 * Inputs:
 *   flowResult: any  (truthy/falsy from acceptInvite return)
 *   flowError:  Error|null (null = no throw)
 *   hostStatus: 'joined'|'pending'|'unknown'|'timeout'|'degraded'
 *
 * Output: { finalStatus: 'done'|'accept_failed', eventType: string, message: string|null }
 *
 * Rule: hostStatus==='joined' always wins and marks done. Otherwise:
 *   - flow threw → accept_failed/fail with original error
 *   - flow truthy → accept_failed/accept_failed_unconfirmed (warn)
 *   - flow falsy  → accept_failed/fail
 */
const VALID_HOST_STATUSES = ['joined', 'pending', 'unknown', 'timeout', 'degraded'];

function decide({ flowResult, flowError, hostStatus }) {
    if (!VALID_HOST_STATUSES.includes(hostStatus)) {
        throw new TypeError(`decide: invalid hostStatus '${hostStatus}', expected one of ${VALID_HOST_STATUSES.join(', ')}`);
    }
    const joined = hostStatus === 'joined';

    if (flowError) {
        if (joined) {
            return {
                finalStatus: 'done',
                eventType: 'success',
                message: `flow threw: ${flowError.message} but host confirmed joined`,
            };
        }
        return {
            finalStatus: 'accept_failed',
            eventType: 'fail',
            message: flowError.message,
        };
    }

    if (flowResult) {
        if (joined) {
            return { finalStatus: 'done', eventType: 'success', message: null };
        }
        return {
            finalStatus: 'accept_failed',
            eventType: 'accept_failed_unconfirmed',
            message: 'flow ok but host-page not confirmed within 2min',
        };
    }

    // falsy, no throw
    if (joined) {
        return {
            finalStatus: 'done',
            eventType: 'success',
            message: 'flow returned falsy but host confirmed joined',
        };
    }
    return {
        finalStatus: 'accept_failed',
        eventType: 'fail',
        message: 'acceptInvite returned falsy',
    };
}

module.exports = { decide, VALID_HOST_STATUSES };
