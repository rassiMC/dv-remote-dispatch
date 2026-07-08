const SwitchboardMapper = {
    ingameGraph: null,
    switchboardGraph: null,
    mapping: null,

    GRAPH_OVERRIDES: {
        // Format: junctionIndex: { neighbors, addNeighbors, commonNeighbor, leftNeighbor, rightNeighbor, degree }
        // 'neighbors' replaces the full array. 'addNeighbors' merges into existing (no duplicates).
        // Only include fields you want to override.
        539: { neighbors: [540, 541, 542], commonNeighbor: 542, leftNeighbor: 540, rightNeighbor: 541, degree: 3 },
        540: { addNeighbors: [539, 541], leftNeighbor: 541, rightNeighbor: 539 },
        541: { addNeighbors: [540, 549], leftNeighbor: 549, rightNeighbor: 540 },
        542: { addNeighbors: [539], commonNeighbor: 539 },
        404: { neighbors: [403, 370, 18], commonNeighbor: 18, leftNeighbor: 403, rightNeighbor: 370, degree: 3 },
        403: { addNeighbors: [404], commonNeighbor: 404 },
        18: { addNeighbors: [404], commonNeighbor: 404 },
        370: { addNeighbors: [404], leftNeighbor: 404 },
        26: { neighbors: [27], leftNeighbor: 27, rightNeighbor: 77 },
        125: { neighbors: [121, 123], leftNeighbor: 123, rightNeighbor: 121 },
    },

    async fetchIngameGraph() {
        const resp = await fetch(new URL('/graph', location));
        if (!resp.ok) throw new Error(`Failed to fetch /graph: ${resp.status} ${resp.statusText}`);
        const data = await resp.json();

		this.ingameGraph = new Map();
        for (const [junctionId, graphData] of Object.entries(data)) {
            this.ingameGraph.set(graphData.junctionIndex, {
                junctionId: junctionId,
                junctionIndex: graphData.junctionIndex,
                neighbors: graphData.neighbors || [],
                degree: graphData.degree || (graphData.neighbors || []).length,
                currentBranch: graphData.currentBranch,
                incomingTracks: graphData.incomingTracks || [],
                outgoingTracks: graphData.outgoingTracks || [],
                commonNeighbor: graphData.commonNeighbor ?? null,
                leftNeighbor: graphData.leftNeighbor ?? null,
                rightNeighbor: graphData.rightNeighbor ?? null
            });
        }
        this.applyGraphOverrides();
        return this.ingameGraph;
    },

    applyGraphOverrides() {
        let count = 0;
        for (const [idx, overrides] of Object.entries(this.GRAPH_OVERRIDES)) {
            const jIdx = parseInt(idx);
            const existing = this.ingameGraph.get(jIdx);
            if (existing) {
                if (overrides.addNeighbors) {
                    for (const n of overrides.addNeighbors) {
                        if (!existing.neighbors.includes(n)) existing.neighbors.push(n);
                    }
                    delete overrides.addNeighbors;
                    if (!overrides.degree) overrides.degree = existing.neighbors.length;
                }
                Object.assign(existing, overrides);
            } else {
                const neighbors = overrides.neighbors || overrides.addNeighbors || [];
                this.ingameGraph.set(jIdx, {
                    junctionId: `override_${jIdx}`,
                    junctionIndex: jIdx,
                    neighbors: neighbors,
                    degree: overrides.degree ?? neighbors.length,
                    currentBranch: overrides.currentBranch ?? 0,
                    incomingTracks: overrides.incomingTracks || [],
                    outgoingTracks: overrides.outgoingTracks || [],
                    commonNeighbor: overrides.commonNeighbor ?? null,
                    leftNeighbor: overrides.leftNeighbor ?? null,
                    rightNeighbor: overrides.rightNeighbor ?? null
                });
            }
            count++;
        }
        if (count > 0) console.log(`Applied ${count} graph overrides`);
    },

    buildSwitchboardGraph() {
        this.switchboardGraph = TrackData.buildSwitchGraph();
        return this.switchboardGraph;
    },

    findMatches(sbNeighbors, ingameNeighbors, usedIngameIndices, ingameIdx) {
        const matches = [];
        const unmatchedIngame = ingameNeighbors.filter(idx => !usedIngameIndices.has(idx));
        const ingameData = this.ingameGraph.get(ingameIdx);

        const portToIngameNeighbor = (port) => {
            if (!ingameData) return null;
            if (port === 'common') return ingameData.commonNeighbor;
            if (port === 'left') return ingameData.leftNeighbor;
            if (port === 'right') return ingameData.rightNeighbor;
            return null;
        };

        const usedThisRound = new Set();

        const sorted = [...sbNeighbors].sort((a, b) => {
            const order = { right: 0, left: 1, common: 2 };
            const pa = order[a.port] ?? 3;
            const pb = order[b.port] ?? 3;
            return pa - pb;
        });

        for (const sbNeighbor of sorted) {
            if (sbNeighbor.switchId === undefined) continue;
            if (usedThisRound.has(sbNeighbor.switchId)) continue;

            const sbData = this.switchboardGraph.get(sbNeighbor.switchId);
            if (!sbData) continue;

            const port = sbNeighbor.port || 'unknown';
            let matchedIngameIdx = null;

            const portTarget = portToIngameNeighbor(port);
            if (portTarget !== null && unmatchedIngame.includes(portTarget)) {
                matchedIngameIdx = portTarget;
            }

            if (matchedIngameIdx === null) {
                let bestScore = -1;
                for (const ingameIdx of unmatchedIngame) {
                    const candidateData = this.ingameGraph.get(ingameIdx);
                    if (!candidateData) continue;
                    if (candidateData.degree === sbData.degree) {
                        matchedIngameIdx = ingameIdx;
                        break;
                    }
                    const score = 1.0 / (1 + Math.abs(candidateData.degree - sbData.degree));
                    if (score > bestScore) {
                        bestScore = score;
                        matchedIngameIdx = ingameIdx;
                    }
                }
            }

            if (matchedIngameIdx !== null) {
                matches.push({
                    sbSwitchId: sbNeighbor.switchId,
                    ingameJunctionIndex: matchedIngameIdx,
                    port: port
                });
                unmatchedIngame.splice(unmatchedIngame.indexOf(matchedIngameIdx), 1);
                usedThisRound.add(sbNeighbor.switchId);
            }
        }

        return matches;
    },

    runParallelWalk(anchorSbId, anchorIngameIdx) {
        if (!this.ingameGraph || !this.switchboardGraph) {
            console.error('Graphs not loaded. Call fetchIngameGraph() and buildSwitchGraph() first.');
            return null;
        }

        const mapping = new Map();
        mapping.set(anchorSbId, anchorIngameIdx);

        const usedIngame = new Set([anchorIngameIdx]);
        const queue = [{sbId: anchorSbId, ingameIdx: anchorIngameIdx}];
        const visitedSb = new Set([anchorSbId]);

        while (queue.length > 0) {
            const {sbId, ingameIdx} = queue.shift();

            const sbData = this.switchboardGraph.get(sbId);
            const ingameData = this.ingameGraph.get(ingameIdx);

            if (!sbData || !ingameData) continue;

            const sbNeighbors = sbData.neighbors.filter(n => !visitedSb.has(n.switchId));
            const ingameNeighbors = ingameData.neighbors.filter(idx => !usedIngame.has(idx));

            const matches = this.findMatches(sbNeighbors, ingameNeighbors, usedIngame, ingameIdx);

            for (const match of matches) {
                mapping.set(match.sbSwitchId, match.ingameJunctionIndex);
                visitedSb.add(match.sbSwitchId);
                usedIngame.add(match.ingameJunctionIndex);
                queue.push({sbId: match.sbSwitchId, ingameIdx: match.ingameJunctionIndex});
            }
        }

        this.mapping = mapping;
        return mapping;
    },

    getIngameJunctionIndex(sbSwitchId) {
        if (!this.mapping) return null;
        return this.mapping.has(sbSwitchId) ? this.mapping.get(sbSwitchId) : null;
    },

    getSwitchboardId(ingameJunctionIndex) {
        if (!this.mapping) return null;
        for (const [sbId, idx] of this.mapping) {
            if (idx === ingameJunctionIndex) return sbId;
        }
        return null;
    },

    getUnmappedSwitches() {
        if (!this.mapping || !this.switchboardGraph) return [];
        const unmapped = [];
        for (const [sbId] of this.switchboardGraph) {
            if (!this.mapping.has(sbId)) unmapped.push(sbId);
        }
        return unmapped;
    },

    getUnmappedJunctions() {
        if (!this.mapping || !this.ingameGraph) return [];
        const unmapped = [];
        for (const [idx] of this.ingameGraph) {
            let found = false;
            for (const [, mappedIdx] of this.mapping) {
                if (mappedIdx === idx) { found = true; break; }
            }
            if (!found) unmapped.push(idx);
        }
        return unmapped;
    },

    printMapping() {
        if (!this.mapping) {
            console.log('No mapping built yet.');
            return;
        }
        console.log(`Switch mapping (${this.mapping.size} pairs)`);
        const unmappedSb = this.getUnmappedSwitches();
        const unmappedIn = this.getUnmappedJunctions();
        if (unmappedSb.length > 0) {
            console.warn(`Unmapped switchboard switches: ${unmappedSb.join(', ')}`);
        }
        if (unmappedIn.length > 0) {
            console.warn(`Unmapped ingame junctions: ${unmappedIn.join(', ')}`);
        }
    }
};
