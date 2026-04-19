/**
 * Spread strategy: prefer hosts with FEWEST used slots.
 * See spec §6 "Host 分配".
 */
function pickHost(hosts, hostFilter) {
    const filter = (hostFilter || []).map(s => String(s).toLowerCase());
    const candidates = hosts.filter(h => {
        if (h.disabled) return false;
        if ((h.slot_free || 0) <= 0) return false;
        if (filter.length && !filter.includes(String(h.email).toLowerCase())) return false;
        return true;
    });
    if (!candidates.length) return null;
    candidates.sort((a, b) => {
        const su = (a.slot_used || 0) - (b.slot_used || 0);
        if (su !== 0) return su;
        return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    });
    return candidates[0];
}

module.exports = { pickHost };
