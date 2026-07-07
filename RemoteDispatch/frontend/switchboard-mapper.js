const SwitchboardMapper = {
    ingameGraph: null,
    switchboardGraph: null,
    mapping: null,

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
                outgoingTracks: graphData.outgoingTracks || []
            });
        }
        return this.ingameGraph;
    },

    buildSwitchboardGraph() {
        this.switchboardGraph = TrackData.buildSwitchGraph();
        return this.switchboardGraph;
    },

    findMatches(sbNeighbors, ingameNeighbors, usedIngameIndices) {
        const matches = [];
        const unmatchedIngame = ingameNeighbors.filter(idx => !usedIngameIndices.has(idx));

        for (const sbNeighbor of sbNeighbors) {
            if (sbNeighbor.switchId === undefined) continue;
            const sbData = this.switchboardGraph.get(sbNeighbor.switchId);
            if (!sbData) continue;

            let bestMatch = null;
            let bestScore = -1;

            for (const ingameIdx of unmatchedIngame) {
                const ingameData = this.ingameGraph.get(ingameIdx);
                if (!ingameData) continue;

                if (ingameData.degree === sbData.degree) {
                    matches.push({
                        sbSwitchId: sbNeighbor.switchId,
                        ingameJunctionIndex: ingameIdx
                    });
                    unmatchedIngame.splice(unmatchedIngame.indexOf(ingameIdx), 1);
                    break;
                }

                const score = 1.0 / (1 + Math.abs(ingameData.degree - sbData.degree));
                if (score > bestScore) {
                    bestScore = score;
                    bestMatch = ingameIdx;
                }
            }

            if (bestMatch !== null && bestScore > 0) {
                matches.push({
                    sbSwitchId: sbNeighbor.switchId,
                    ingameJunctionIndex: bestMatch
                });
                unmatchedIngame.splice(unmatchedIngame.indexOf(bestMatch), 1);
            }
        }

        return matches;
    },

    runParallelWalk(anchorSbId, anchorIngameIdx) {
        if (!this.ingameGraph || !this.switchboardGraph) {
            console.error('Graphs not loaded. Call fetchIngameGraph() and buildSwitchboardGraph() first.');
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

            const matches = this.findMatches(sbNeighbors, ingameNeighbors, usedIngame);

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
        console.log(`Switch mapping (${this.mapping.size} pairs):`);
        for (const [sbId, ingameIdx] of this.mapping) {
            const sbData = this.switchboardGraph?.get(sbId);
            const ingameData = this.ingameGraph?.get(ingameIdx);
            console.log(`  ${sbId} (deg ${sbData?.degree ?? '?'}) -> junction ${ingameIdx} (deg ${ingameData?.degree ?? '?'})`);
        }

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
