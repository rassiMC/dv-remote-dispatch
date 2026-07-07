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

    dumpIngameGraph() {
        if (!this.ingameGraph) {
            console.log('No ingame graph loaded.');
            return;
        }
        console.log(`%c=== Ingame Graph (${this.ingameGraph.size} junctions) ===`, 'color: #00BFFF; font-weight: bold');
        for (const [idx, data] of [...this.ingameGraph.entries()].sort((a, b) => a[0] - b[0])) {
            const ports = [
                data.commonNeighbor !== null ? `common=${data.commonNeighbor}` : 'common=null',
                data.leftNeighbor !== null ? `left=${data.leftNeighbor}` : 'left=null',
                data.rightNeighbor !== null ? `right=${data.rightNeighbor}` : 'right=null'
            ].join(', ');
            const hasNull = data.commonNeighbor === null || data.leftNeighbor === null || data.rightNeighbor === null;
            const style = hasNull ? 'color: #ff4444' : '';
            console.log(`  J${idx}: deg=${data.degree}, neighbors=[${data.neighbors.join(',')}], ${ports}${hasNull ? ' ⚠ NULL PORT' : ''}`, style ? '' : '');
        }
    },

    dumpSwitchboardGraph() {
        if (!this.switchboardGraph) {
            console.log('No switchboard graph loaded.');
            return;
        }
        console.log(`%c=== Switchboard Graph (${this.switchboardGraph.size} switches) ===`, 'color: #00ff00; font-weight: bold');
        for (const [sbId, data] of this.switchboardGraph) {
            const neighborStrs = data.neighbors.map(n => `${n.switchId}(${n.port})`);
            console.log(`  ${sbId}: deg=${data.degree}, neighbors=[${neighborStrs.join(', ')}]`);
        }
    },

    printMapping() {
        if (!this.mapping) {
            console.log('No mapping built yet.');
            return;
        }
        console.log(`%c=== Switch Mapping (${this.mapping.size} pairs) ===`, 'color: #ffaa00; font-weight: bold');
        for (const [sbId, ingameIdx] of this.mapping) {
            const sbData = this.switchboardGraph?.get(sbId);
            const ingameData = this.ingameGraph?.get(ingameIdx);
            const degMatch = sbData?.degree === ingameData?.degree;
            console.log(`  ${sbId} (deg ${sbData?.degree ?? '?'}) -> J${ingameIdx} (deg ${ingameData?.degree ?? '?'})${degMatch ? '' : ' ⚠ DEG MISMATCH'}`);
        }

        const unmappedSb = this.getUnmappedSwitches();
        const unmappedIn = this.getUnmappedJunctions();
        if (unmappedSb.length > 0) {
            console.warn(`%c=== Unmapped Switchboard Switches (${unmappedSb.length}) ===`, 'color: #ff4444; font-weight: bold');
            for (const sbId of unmappedSb) {
                const sbData = this.switchboardGraph?.get(sbId);
                const neighborStrs = sbData?.neighbors.map(n => `${n.switchId}(${n.port})`) ?? [];
                const mappedNeighbors = sbData?.neighbors.filter(n => this.mapping.has(n.switchId)).map(n => `${n.switchId}->J${this.mapping.get(n.switchId)}`) ?? [];
                console.warn(`  ${sbId}: deg=${sbData?.degree ?? '?'}, neighbors=[${neighborStrs.join(', ')}], mapped_neighbors=[${mappedNeighbors.join(', ')}]`);
            }
        }
        if (unmappedIn.length > 0) {
            console.warn(`%c=== Unmapped Ingame Junctions (${unmappedIn.length}) ===`, 'color: #ff4444; font-weight: bold');
            for (const idx of unmappedIn) {
                const ingameData = this.ingameGraph?.get(idx);
                const ports = [
                    ingameData?.commonNeighbor !== null ? `common=${ingameData?.commonNeighbor}` : 'common=null',
                    ingameData?.leftNeighbor !== null ? `left=${ingameData?.leftNeighbor}` : 'left=null',
                    ingameData?.rightNeighbor !== null ? `right=${ingameData?.rightNeighbor}` : 'right=null'
                ].join(', ');
                console.warn(`  J${idx}: deg=${ingameData?.degree ?? '?'}, neighbors=[${ingameData?.neighbors.join(',') ?? ''}], ${ports}`);
            }
        }
    },

    dumpToFile() {
        let lines = [];

        lines.push(`=== INGAME GRAPH ===`);
        if (this.ingameGraph) {
            lines.push(`Junctions: ${this.ingameGraph.size}`);
            for (const [idx, data] of [...this.ingameGraph.entries()].sort((a, b) => a[0] - b[0])) {
                const ports = [
                    data.commonNeighbor !== null ? `common=${data.commonNeighbor}` : 'common=null',
                    data.leftNeighbor !== null ? `left=${data.leftNeighbor}` : 'left=null',
                    data.rightNeighbor !== null ? `right=${data.rightNeighbor}` : 'right=null'
                ].join(', ');
                const hasNull = data.commonNeighbor === null || data.leftNeighbor === null || data.rightNeighbor === null;
                lines.push(`J${idx}: deg=${data.degree}, neighbors=[${data.neighbors.join(',')}], ${ports}${hasNull ? ' WARN_NULL_PORT' : ''}`);
            }
        } else {
            lines.push('No ingame graph loaded.');
        }

        lines.push('');
        lines.push(`=== SWITCHBOARD GRAPH ===`);
        if (this.switchboardGraph) {
            lines.push(`Switches: ${this.switchboardGraph.size}`);
            for (const [sbId, data] of this.switchboardGraph) {
                const neighborStrs = data.neighbors.map(n => `${n.switchId}(${n.port})`);
                lines.push(`${sbId}: deg=${data.degree}, neighbors=[${neighborStrs.join(', ')}]`);
            }
        } else {
            lines.push('No switchboard graph loaded.');
        }

        lines.push('');
        lines.push(`=== MAPPING ===`);
        if (this.mapping) {
            lines.push(`Pairs: ${this.mapping.size}`);
            for (const [sbId, ingameIdx] of this.mapping) {
                const sbData = this.switchboardGraph?.get(sbId);
                const ingameData = this.ingameGraph?.get(ingameIdx);
                const degMatch = sbData?.degree === ingameData?.degree;
                lines.push(`${sbId} (deg ${sbData?.degree ?? '?'}) -> J${ingameIdx} (deg ${ingameData?.degree ?? '?'})${degMatch ? '' : ' WARN_DEG_MISMATCH'}`);
            }

            const unmappedSb = this.getUnmappedSwitches();
            const unmappedIn = this.getUnmappedJunctions();
            lines.push('');
            lines.push(`UNMAPPED SWITCHBOARD SWITCHES (${unmappedSb.length}):`);
            for (const sbId of unmappedSb) {
                const sbData = this.switchboardGraph?.get(sbId);
                const neighborStrs = sbData?.neighbors.map(n => `${n.switchId}(${n.port})`) ?? [];
                const mappedNeighbors = sbData?.neighbors.filter(n => this.mapping.has(n.switchId)).map(n => `${n.switchId}->J${this.mapping.get(n.switchId)}`) ?? [];
                lines.push(`  ${sbId}: deg=${sbData?.degree ?? '?'}, neighbors=[${neighborStrs.join(', ')}], mapped_neighbors=[${mappedNeighbors.join(', ')}]`);
            }
            lines.push('');
            lines.push(`UNMAPPED INGAME JUNCTIONS (${unmappedIn.length}):`);
            for (const idx of unmappedIn) {
                const ingameData = this.ingameGraph?.get(idx);
                const ports = [
                    ingameData?.commonNeighbor !== null ? `common=${ingameData?.commonNeighbor}` : 'common=null',
                    ingameData?.leftNeighbor !== null ? `left=${ingameData?.leftNeighbor}` : 'left=null',
                    ingameData?.rightNeighbor !== null ? `right=${ingameData?.rightNeighbor}` : 'right=null'
                ].join(', ');
                lines.push(`  J${idx}: deg=${ingameData?.degree ?? '?'}, neighbors=[${ingameData?.neighbors.join(',') ?? ''}], ${ports}`);
            }
        } else {
            lines.push('No mapping built yet.');
        }

        const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'graph_dump.txt';
        a.click();
        URL.revokeObjectURL(url);
    }
};
