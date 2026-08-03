const PathingController = {
    enabled: false,
    state: 'idle',
    startBlockId: null,
    destBlockId: null,
    currentPathBlocks: [],
    currentPathSwitchAssignments: {},
    lockedPaths: [],
    _blockGraph: null,
    _blockSwitchPorts: null,
    _onKeyDown: null,
    _hoverBlockId: null,
    _hoverTimer: null,
    _needsRerender: false,

    MODE_YELLOW: '#ffdd44',
    MODE_BLUE: '#4488ff',
    MODE_GREEN: '#208020',
    MODE_RED: '#a02020',

    get showGrayClear() {
        return this.enabled;
    },

    buildBlockGraph() {
        const graph = new Map();
        if (!TrackData.blocks || !TrackData.segments) return graph;

        for (const [blockId] of TrackData.blocks) {
            graph.set(blockId, { neighbors: [] });
        }

        this._blockSwitchPorts = new Map();
        this._switchSwitchPorts = new Map();

        const nodeToBlocks = new Map();
        for (const [segId, seg] of TrackData.segments) {
            if (!seg.blockId) continue;
            for (const nodeName of ['n1', 'n2', 'merging', 'nl', 'nr']) {
                const nid = seg[nodeName];
                if (!nid) continue;
                if (!nodeToBlocks.has(nid)) nodeToBlocks.set(nid, []);
                if (!nodeToBlocks.get(nid).find(e => e.blockId === seg.blockId && e.segId === segId))
                    nodeToBlocks.get(nid).push({ blockId: seg.blockId, segId, type: seg.type });
            }
        }

        for (const [nodeId, entries] of nodeToBlocks) {
            if (entries.length < 2) continue;
            for (let i = 0; i < entries.length; i++) {
                for (let j = i + 1; j < entries.length; j++) {
                    const a = entries[i], b = entries[j];
                    if (a.blockId === b.blockId) continue;
                    this._addEdge(graph, a, b, nodeId);
                    this._addEdge(graph, b, a, nodeId);
                }
            }
        }

        this._blockGraph = graph;
        return graph;
    },

    _addEdge(graph, from, to, nodeId) {
        const entry = graph.get(from.blockId);
        if (!entry || entry.neighbors.find(n => n.blockId === to.blockId)) return;

        const fromSeg = TrackData.getSegment(from.segId);
        const toSeg = TrackData.getSegment(to.segId);

        let port = null;
        if (fromSeg.type === 'switch') {
            for (const { nodeName, portName } of [
                { nodeName: 'merging', portName: 'common' },
                { nodeName: 'nl', portName: 'left' },
                { nodeName: 'nr', portName: 'right' }
            ]) {
                if (fromSeg[nodeName] === nodeId) { port = portName; break; }
            }
        }

        entry.neighbors.push({ blockId: to.blockId, port: port });

        if (fromSeg.type === 'switch' || toSeg.type === 'switch') {
            const key = `${to.blockId}@${from.blockId}`;
            if (!this._blockSwitchPorts.has(key))
                this._blockSwitchPorts.set(key, port);
        }
    },

    _getPortForBlockAtSwitch(blockId, switchBlockId) {
        return this._blockSwitchPorts.get(`${blockId}@${switchBlockId}`) || null;
    },

    computeBlockPath(fromBlockId, toBlockId) {
        if (!this._blockGraph) this.buildBlockGraph();
        const graph = this._blockGraph;
        if (!graph.has(fromBlockId) || !graph.has(toBlockId)) return null;

        const openSet = [fromBlockId];
        const cameFrom = new Map();
        const gScore = new Map();
        gScore.set(fromBlockId, 0);
        const openIdx = new Map();
        openIdx.set(fromBlockId, 0);

        while (openSet.length > 0) {
            let current = openSet[0], currentG = gScore.get(current) ?? Infinity;
            let bestIdx = 0;
            for (let i = 1; i < openSet.length; i++) {
                const g = gScore.get(openSet[i]) ?? Infinity;
                if (g < currentG) { currentG = g; current = openSet[i]; bestIdx = i; }
            }
            openSet[bestIdx] = openSet[openSet.length - 1];
            openSet.pop();
            openIdx.delete(current);

            if (current === toBlockId) {
                const path = [];
                let node = current;
                while (node) {
                    path.unshift(node);
                    node = cameFrom.get(node);
                }
                const switchAssignments = {};
                for (let i = 1; i < path.length - 1; i++) {
                    const blockId = path[i];
                    const prevBlock = path[i - 1];
                    const nextBlock = path[i + 1];

                    const isSwitch = Array.from(TrackData.segments.values()).some(
                        s => s.type === 'switch' && s.blockId === blockId
                    );
                    if (!isSwitch) continue;

                    const inPort = this._getPortForBlockAtSwitch(prevBlock, blockId);
                    const outPort = this._getPortForBlockAtSwitch(nextBlock, blockId);
                    if (!inPort || !outPort) continue;

                    const branch = inPort === 'common' && outPort === 'left' ? 0 :
                        inPort === 'common' && outPort === 'right' ? 1 :
                        outPort === 'common' && inPort === 'left' ? 0 :
                        outPort === 'common' && inPort === 'right' ? 1 : null;
                    if (branch !== null)
                        switchAssignments[blockId] = branch;
                    else
                        return null;
                }
                return { blocks: path, switchAssignments };
            }

            const entry = graph.get(current);
            if (!entry) continue;

            for (const neighbor of entry.neighbors) {
                const nbrId = neighbor.blockId;
                const tentG = (gScore.get(current) ?? Infinity) + 1;
                if (tentG < (gScore.get(nbrId) ?? Infinity)) {
                    cameFrom.set(nbrId, current);
                    gScore.set(nbrId, tentG);
                    if (!openIdx.has(nbrId)) {
                        openSet.push(nbrId);
                        openIdx.set(nbrId, openSet.length - 1);
                    }
                }
            }
        }
        return null;
    },

    _getSignalIdsForPath(path) {
        const ids = [];
        for (let i = 1; i < path.length - 1; i++) {
            const blockId = path[i];
            const prevBlock = path[i - 1];
            const entryPort = this._getPortForBlockAtSwitch(prevBlock, blockId);
            if (!entryPort) continue;
            for (const [segId, seg] of TrackData.segments) {
                if (seg.type !== 'switch') continue;
                if (seg.blockId !== blockId) continue;
                const rawSigs = SwitchboardMapper.switchboardGraph?.get(segId)?.rawSignals;
                if (!rawSigs) continue;
                if (entryPort === 'common' && rawSigs.Out && rawSigs.Out.Id)
                    ids.push(rawSigs.Out.Id);
                if (entryPort === 'left' && rawSigs.LeftIn && rawSigs.LeftIn.Id)
                    ids.push(rawSigs.LeftIn.Id);
                if (entryPort === 'right' && rawSigs.RightIn && rawSigs.RightIn.Id)
                    ids.push(rawSigs.RightIn.Id);
            }
        }
        return ids;
    },

    _getBlockSignalIds(path) {
        const blockSignals = {};
        for (let i = 1; i < path.length - 1; i++) {
            const blockId = path[i];
            const prevBlock = path[i - 1];
            const entryPort = this._getPortForBlockAtSwitch(prevBlock, blockId);
            if (!entryPort) continue;
            for (const [segId, seg] of TrackData.segments) {
                if (seg.type !== 'switch') continue;
                if (seg.blockId !== blockId) continue;
                const rawSigs = SwitchboardMapper.switchboardGraph?.get(segId)?.rawSignals;
                if (!rawSigs) continue;
                let sigId = null;
                if (entryPort === 'common' && rawSigs.Out && rawSigs.Out.Id)
                    sigId = rawSigs.Out.Id;
                else if (entryPort === 'left' && rawSigs.LeftIn && rawSigs.LeftIn.Id)
                    sigId = rawSigs.LeftIn.Id;
                else if (entryPort === 'right' && rawSigs.RightIn && rawSigs.RightIn.Id)
                    sigId = rawSigs.RightIn.Id;
                if (sigId) blockSignals[blockId] = sigId;
            }
        }
        return blockSignals;
    },

    _resetSelection() {
        this.state = 'idle';
        this.startBlockId = null;
        this.destBlockId = null;
        this.currentPathBlocks = [];
        this.currentPathSwitchAssignments = {};
    },

    onBlockClick(blockId) {
        if (!this.enabled) return;
        this._needsRerender = false;
        if (this._hoverTimer) {
            clearTimeout(this._hoverTimer);
            this._hoverTimer = null;
        }
        if (this.state === 'idle') {
            const block = TrackData.getBlock(blockId);
            if (!block || block.occupancyState !== 'occupied') {
                this.updateStatus('Start block must be occupied by a train.');
                return;
            }
            this.startBlockId = blockId;
            this.state = 'selectingDest';
            this.updateStatus(`Start block: ${blockId}. Click a destination block.`);
            this.rerender();
        } else if (this.state === 'selectingDest') {
            if (blockId === this.startBlockId) return;
            const result = this.computeBlockPath(this.startBlockId, blockId);
            if (result && result.blocks.length > 0) {
                this.destBlockId = blockId;
                this._needsRerender = true;
                this.confirmPath(result.blocks, result.switchAssignments, this.startBlockId, blockId);
            } else {
                this.updateStatus('No path found between those blocks.');
            }
        }
    },

    onBlockHover(blockId) {
        if (this.state !== 'selectingDest') return;
        if (blockId === this.startBlockId || blockId === this._hoverBlockId) return;
        if (this._needsRerender) return;
        this._hoverBlockId = blockId;

        if (this._hoverTimer) {
            clearTimeout(this._hoverTimer);
            this._hoverTimer = null;
        }

        this._hoverTimer = setTimeout(() => {
            this._hoverTimer = null;
            const result = this.computeBlockPath(this.startBlockId, blockId);
            const oldBlocks = this.currentPathBlocks;
            this.currentPathBlocks = [];
            this.currentPathSwitchAssignments = {};
            if (oldBlocks.length > 0)
                this._updateSegmentColors(oldBlocks);
            if (result && result.blocks.length > 0) {
                this.currentPathBlocks = result.blocks;
                this.currentPathSwitchAssignments = result.switchAssignments;
                this._updateSegmentColors(result.blocks);
            }
        }, 30);
    },

    onBlockHoverEnd() {
        if (this._needsRerender) return;
        this._hoverBlockId = null;
        if (this._hoverTimer) {
            clearTimeout(this._hoverTimer);
            this._hoverTimer = null;
        }
    },

    _updateSegmentColors(blockIds) {
        if (typeof switchboardRenderer === 'undefined' || !switchboardRenderer) return;
        for (const blockId of blockIds) {
            const segmentIds = this._getSegmentIdsForBlock(blockId);
            for (const segId of segmentIds) {
                const seg = TrackData.getSegment(segId);
                if (!seg) continue;
                const color = this._getSegmentColor(segId);
                switchboardRenderer.setSegmentColor(seg, color);
            }
        }
    },

    _getSegmentIdsForBlock(blockId) {
        const block = TrackData.getBlock(blockId);
        if (!block || !block.segmentIds) return [];
        return block.segmentIds;
    },

    _getSegmentColor(segId) {
        const seg = TrackData.getSegment(segId);
        if (!seg || !seg.blockId) return null;
        const blockId = seg.blockId;
        const override = this.getOverridesForSegment(segId);
        if (override) return override.color;
        if (seg.type === 'switch') {
            const rim = this.getSwitchRimColor(segId);
            if (rim) return rim;
        }
        const block = TrackData.getBlock(blockId);
        if (!block) return '#888';
        if (block.occupancyState === 'occupied') return '#a02020';
        if (block.occupancyState === 'clear') return this.showGrayClear ? '#888' : '#208020';
        return '#888';
    },

    confirmPath(blocks, switchAssignments, startBlock, destBlock) {
        if (!blocks || blocks.length === 0) return;

        const signalIds = this._getSignalIdsForPath(blocks);
        const blockSignals = this._getBlockSignalIds(blocks);
        const pathBlocks = blocks.slice();
        const pathAssignments = Object.assign({}, switchAssignments);

        const pathEntry = {
            blocks: pathBlocks,
            startBlock: startBlock,
            destBlock: destBlock,
            switchAssignments: pathAssignments,
            signalIds: signalIds,
            blockSignals: blockSignals
        };

        this._resetSelection();

        fetch(new URL('/path', location), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(pathEntry)
        })
        .then(resp => resp.ok ? resp.json() : null)
        .then(data => {
            if (data && data.id) {
                fetch(new URL('/path', location))
                    .then(resp => resp.json())
                    .then(serverData => {
                        this.syncFromServer(serverData);
                        this.updateStatus(`Path locked (${pathBlocks.length} blocks). ${this.lockedPaths.length} path(s) active.`);
                    });
            }
        })
        .catch(() => this.updateStatus('Failed to create path.'));
    },

    onSegmentClick(segmentId) {
        if (!this.enabled) return;
        const seg = TrackData.getSegment(segmentId);
        if (!seg || !seg.blockId) return;
        this.onBlockClick(seg.blockId);
    },

    onSegmentHover(segmentId) {
        if (this.state !== 'selectingDest') return;
        const seg = TrackData.getSegment(segmentId);
        if (!seg || !seg.blockId) return;
        this.onBlockHover(seg.blockId);
    },

    onSegmentHoverEnd() {
        this.onBlockHoverEnd();
    },

    getOverridesForSegment(segId) {
        const seg = TrackData.getSegment(segId);
        if (!seg || !seg.blockId) return null;
        const blockId = seg.blockId;

        if (this.lockedPaths.length > 0) {
            for (const p of this.lockedPaths) {
                if (p.blocks && p.blocks.includes(blockId)) {
                    if (p.blockStates && p.blockStates[blockId]) {
                        const state = p.blockStates[blockId];
                        if (state === 'claimed') return { color: this.MODE_GREEN };
                        if (state === 'unclaimed' || state === 'waiting') return { color: this.MODE_YELLOW };
                        return null;
                    }
                }
            }
        }

        if (this.currentPathBlocks.includes(blockId)) {
            const block = TrackData.getBlock(blockId);
            if (block && block.occupancyState === 'occupied') return { color: this.MODE_RED };
            if (blockId === this.startBlockId) return { color: this.MODE_BLUE };
            if (blockId === this.destBlockId) return { color: this.MODE_YELLOW };
            return { color: this.MODE_YELLOW };
        }

        return null;
    },

    getSwitchRimColor(swId) {
        const seg = TrackData.getSegment(swId);
        if (!seg || !seg.blockId) return null;
        const blockId = seg.blockId;

        if (this.lockedPaths.length > 0) {
            for (const p of this.lockedPaths) {
                if (p.blocks && p.blocks.includes(blockId)) {
                    if (p.blockStates && p.blockStates[blockId]) {
                        const state = p.blockStates[blockId];
                        if (state === 'claimed') return this.MODE_GREEN;
                        if (state === 'unclaimed' || state === 'waiting') return this.MODE_YELLOW;
                        return null;
                    }
                }
            }
        }

        if (this.currentPathBlocks.includes(blockId)) {
            return this.MODE_YELLOW;
        }

        return null;
    },

    syncFromServer(serverPaths) {
        if (!this.enabled) return;
        const oldBlockIds = new Set();
        for (const p of this.lockedPaths) {
            if (p.blocks) for (const b of p.blocks) oldBlockIds.add(b);
        }

        const paths = Array.isArray(serverPaths) ? serverPaths : [];
        this.lockedPaths = paths;

        const newBlockIds = new Set();
        for (const p of this.lockedPaths) {
            if (p.blocks) for (const b of p.blocks) newBlockIds.add(b);
        }

        const allBlockIds = new Set([...oldBlockIds, ...newBlockIds]);
        const changedSegments = [];
        for (const blockId of allBlockIds) {
            const block = TrackData.getBlock(blockId);
            if (block && block.segmentIds) {
                changedSegments.push(...block.segmentIds);
            }
        }

        this.rerender(changedSegments, []);
        this.renderPathList();
    },

    clearAll() {
        if (this.lockedPaths.length === 0) {
            this._resetSelection();
            this.rerender();
            this.updateStatus('');
            return;
        }
        if (!confirm('Clear all paths? This cannot be undone.')) return;
        fetch(new URL('/path', location), { method: 'DELETE' })
            .then(resp => {
                if (resp.ok) {
                    this.lockedPaths = [];
                    this._resetSelection();
                    this.rerender();
                    this.updateStatus('All paths cleared.');
                } else if (resp.status === 403) {
                    this.updateStatus('Permission denied.');
                }
            });
    },

    enable() {
        if (this.enabled) return;
        this.enabled = true;
        this.buildBlockGraph();
        this._attachKeyHandler();
        this.updateStatus('Loading paths...');
        fetch(new URL('/path', location))
            .then(resp => resp.json())
            .then(data => {
                this.lockedPaths = Array.isArray(data) ? data : [];
                this.rerender();
                this.updateStatus('Click an occupied block to start, then a destination block.');
            })
            .catch(() => {
                this.rerender();
                this.updateStatus('Click an occupied block to start, then a destination block.');
            });
        this._activateWithRetry();
    },

    _activateWithRetry(attempts) {
        if (attempts === undefined) attempts = 0;
        if (attempts > 20) { console.warn('[Pathing] Activation failed'); return; }
        fetch(new URL('/pathing/activate', location), { method: 'POST' })
            .then(resp => {
                if (resp.ok) console.log('[Pathing] Activation sent');
                else if (resp.status === 403) console.warn('[Pathing] No permission');
            })
            .catch(() => {
                setTimeout(() => this._activateWithRetry(attempts + 1), 1000);
            });
    },

    disable() {
        if (!this.enabled) return;
        this.enabled = false;
        this._detachKeyHandler();
        this._resetSelection();
        this.rerender();
        this.updateStatus('disabled');
    },

    _attachKeyHandler() {
        if (this._onKeyDown) return;
        this._onKeyDown = e => {
            if (e.key === 'Escape') {
                if (this.state !== 'idle') {
                    this._resetSelection();
                    this.rerender();
                    this.updateStatus('Cancelled. Click an occupied block to begin.');
                } else if (this.lockedPaths.length > 0) {
                    this.clearAll();
                }
                e.preventDefault();
            }
        };
        document.addEventListener('keydown', this._onKeyDown);
    },

    _detachKeyHandler() {
        if (this._onKeyDown) {
            document.removeEventListener('keydown', this._onKeyDown);
            this._onKeyDown = null;
        }
    },

    _printPath(pathId) {
        const p = this.lockedPaths.find(x => x.id === pathId);
        if (!p) { console.warn('[Pathing] Path not found:', pathId); return; }
        console.log(`=== Path ${pathId}: ${p.startBlock || '?'} → ${p.destBlock || '?'} ===`);
        console.log(`Blocks (${(p.blocks || []).length}):`);
        for (const b of (p.blocks || [])) {
            const state = (p.blockStates && p.blockStates[b]) || 'unclaimed';
            console.log(`  ${b}: ${state}`);
        }
        console.log('Switch assignments:', JSON.stringify(p.switchAssignments));
        console.log('Signal IDs:', p.signalIds);
    },

    _deletePath(pathId) {
        fetch(new URL(`/path/${pathId}`, location), { method: 'DELETE' })
            .then(resp => {
                if (!resp.ok) return;
                fetch(new URL('/path', location))
                    .then(r => r.json())
                    .then(data => this.syncFromServer(data));
            });
    },

    _advancePath(pathId) {
        fetch(new URL(`/path/${pathId}/advance`, location), { method: 'POST' })
            .then(resp => resp.json())
            .then(data => {
                if (data && data.ok) {
                    fetch(new URL('/path', location))
                        .then(r => r.json())
                        .then(serverData => this.syncFromServer(serverData));
                } else {
                    console.warn('[Pathing] Advance failed:', data && data.error);
                }
            });
    },

    _stateColor(state) {
        if (state === 'claimed') return '#208020';
        if (state === 'unclaimed' || state === 'waiting') return '#ffdd44';
        if (state === 'occupied') return '#a02020';
        if (state === 'completed') return '#888';
        return '#666';
    },

    renderPathList() {
        try {
            const el = document.getElementById('pathList');
            if (!el) return;
            if (!this.enabled || this.lockedPaths.length === 0) {
                el.innerHTML = '';
                return;
            }
            const items = this.lockedPaths.map((p) => {
                const label = `${p.startBlock || '?'} \u2192 ${p.destBlock || '?'}`;
                const blockChips = (p.blocks || []).map((b, i) => {
                    const state = (p.blockStates && p.blockStates[b]) || 'unclaimed';
                    const color = this._stateColor(state);
                    const isCurrent = state === 'occupied';
                    const extra = isCurrent ? 'border:1px solid #fff;' : 'border:1px solid transparent;';
                    return `<span style="display:inline-block;background:${color};color:#000;font-size:11px;padding:1px 5px;margin:1px;border-radius:3px;${extra}font-weight:600">${b}</span>`;
                }).join('');
                const pid = p.id;
                return `<div style="margin:6px 0;padding:4px;">
                    <div style="display:flex;align-items:center;gap:6px;">
                        <span style="color:#4c4;font-size:14px">\u2713</span>
                        <span style="font-size:13px;font-weight:600;flex:1">${label}</span>
                        <button onclick="PathingController._printPath('${pid}')" style="font-size:10px;padding:1px 5px;cursor:pointer" title="Print path to F12 console">\u{1F4DD}</button>
                        <button onclick="PathingController._deletePath('${pid}')" style="font-size:10px;padding:1px 5px;cursor:pointer;color:#c44" title="Delete this path">\u2716</button>
                        <button onclick="PathingController._advancePath('${pid}')" style="font-size:10px;padding:1px 5px;cursor:pointer;color:#48f" title="Claim next block">\u25B6</button>
                    </div>
                    <div style="margin-top:4px;line-height:1.8">${blockChips}</div>
                </div>`;
            }).join('');
            el.innerHTML = `<div style="font-size:13px;color:#aaa;margin-bottom:4px;border-bottom:1px solid #444;padding-bottom:3px;font-weight:600">Active Paths (${this.lockedPaths.length})</div>${items}`;
        } catch (e) {
            console.warn('[Pathing] renderPathList error:', e);
        }
    },

    rerender(segments, switches) {
        if (typeof switchboardRenderer === 'undefined' || !switchboardRenderer) return;
        if (segments) {
            for (const segId of segments) {
                const seg = TrackData.getSegment(segId);
                if (seg && seg.type !== 'switch') switchboardRenderer.renderSegment(seg);
            }
        }
        if (switches) {
            for (const swId of switches) {
                const seg = TrackData.getSegment(swId);
                if (seg && seg.type === 'switch') switchboardRenderer.renderSegment(seg);
            }
        }
        if (!segments && !switches) {
            switchboardRenderer.rerenderAllSegments();
            switchboardRenderer.rerenderSwitches();
        }
    },

    updateStatus(msg) {
        try {
            const el = document.getElementById('pathingStatus');
            if (!el) return;
            if (this.enabled) {
                el.textContent = msg ? `Pathing: enabled \u2014 ${msg}` : 'Pathing: enabled';
            } else {
                el.textContent = 'Pathing: disabled';
            }
            this.renderPathList();
        } catch (e) {
            console.warn('[Pathing] updateStatus error:', e);
        }
    }
};
