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
    _serverActive: false,
    _pathTreeCache: null,
    _pathTreeSource: null,
    _pathStatusTable: new Map(),
    _blockSwitchSegments: new Map(),
    _switchBlockIds: new Set(),

    MODE_YELLOW: '#c9a800',
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
        this._blockSwitchSegments = new Map();

        const nodeToBlocks = new Map();
        for (const [segId, seg] of TrackData.segments) {
            if (!seg.blockId) continue;
            if (seg.type === 'switch') {
                this._blockSwitchSegments.set(seg.blockId, segId);
            }
            for (const nodeName of ['n1', 'n2', 'merging', 'nl', 'nr']) {
                const nid = seg[nodeName];
                if (!nid) continue;
                if (!nodeToBlocks.has(nid)) nodeToBlocks.set(nid, []);
                if (!nodeToBlocks.get(nid).find(e => e.blockId === seg.blockId && e.segId === segId))
                    nodeToBlocks.get(nid).push({ blockId: seg.blockId, segId, type: seg.type });
            }
        }
        this._switchBlockIds = new Set(this._blockSwitchSegments.keys());

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
        this._pathTreeCache = null;
        this._pathTreeSource = null;
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

        const tree = this._ensurePathTree(fromBlockId);
        if (!tree.has(toBlockId)) return null;

        const path = [];
        let node = toBlockId;
        while (node !== undefined) {
            path.unshift(node);
            if (node === fromBlockId) break;
            node = tree.get(node);
        }
        if (path[0] !== fromBlockId) return null;

        const switchAssignments = {};
        for (let i = 1; i < path.length - 1; i++) {
            const blockId = path[i];
            if (!this._switchBlockIds.has(blockId)) continue;

            const prevBlock = path[i - 1];
            const nextBlock = path[i + 1];

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
    },

    // Single-source shortest-path tree from `source` (parent-pointer map),
    // computed once per source with a binary heap and memoized. Every hover
    // path query from the same start is then an O(path length) trace-back.
    _ensurePathTree(source) {
        if (this._pathTreeCache && this._pathTreeSource === source) {
            return this._pathTreeCache;
        }
        if (!this._blockGraph) this.buildBlockGraph();
        const graph = this._blockGraph;

        const cameFrom = new Map();
        cameFrom.set(source, undefined);
        const gScore = new Map([[source, 0]]);
        const heap = [{ id: source, g: 0 }];
        const closed = new Set();

        const heapPush = item => {
            const h = heap;
            h.push(item);
            let i = h.length - 1;
            while (i > 0) {
                const p = (i - 1) >> 1;
                if (h[p].g <= h[i].g) break;
                const t = h[p]; h[p] = h[i]; h[i] = t;
                i = p;
            }
        };
        const heapPop = () => {
            const h = heap;
            const top = h[0];
            const last = h.pop();
            if (h.length > 0 && last) {
                h[0] = last;
                let i = 0;
                while (true) {
                    const l = i * 2 + 1;
                    const r = l + 1;
                    let smallest = i;
                    if (l < h.length && h[l].g < h[smallest].g) smallest = l;
                    if (r < h.length && h[r].g < h[smallest].g) smallest = r;
                    if (smallest === i) break;
                    const t = h[i]; h[i] = h[smallest]; h[smallest] = t;
                    i = smallest;
                }
            }
            return top;
        };

        while (heap.length > 0) {
            const current = heapPop().id;
            if (closed.has(current)) continue;
            closed.add(current);
            const curG = gScore.get(current);

            const entry = graph.get(current);
            if (!entry) continue;

            for (const neighbor of entry.neighbors) {
                const nbrId = neighbor.blockId;
                if (closed.has(nbrId)) continue;
                const tentG = curG + 1;
                if (tentG < (gScore.get(nbrId) ?? Infinity)) {
                    gScore.set(nbrId, tentG);
                    cameFrom.set(nbrId, current);
                    heapPush({ id: nbrId, g: tentG });
                }
            }
        }

        this._pathTreeCache = cameFrom;
        this._pathTreeSource = source;
        return cameFrom;
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
        this._pathTreeCache = null;
        this._pathTreeSource = null;
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

        if (this.currentPathBlocks.includes(blockId)) {
            const block = TrackData.getBlock(blockId);
            if (block && block.occupancyState === 'occupied') return this.MODE_RED;
            if (blockId === this.startBlockId) return this.MODE_BLUE;
            if (blockId === this.destBlockId) return this.MODE_YELLOW;
            return this.MODE_YELLOW;
        }

        if (typeof switchboardRenderer !== 'undefined' && switchboardRenderer.resolveBlockColor)
            return switchboardRenderer.resolveBlockColor(blockId, segId);

        const block = TrackData.getBlock(blockId);
        if (!block) return '#888';
        if (block.occupancyState === 'occupied') return this.MODE_RED;
        return '#888';
    },

    getBlockPathStatusTable() {
        return this._pathStatusTable;
    },

    // Rebuild the blockId -> { claimed, upcomingCount } table once per paths
    // sync. resolveBlockColor reads this instead of scanning every path per
    // segment, so block colouring is O(blocks + paths) instead of
    // O(segments x paths) per repaint.
    rebuildPathStatusTable() {
        const table = new Map();
        if (this.enabled) {
            for (const p of this.lockedPaths) {
                if (!p.blocks) continue;
                for (const blockId of p.blocks) {
                    let entry = table.get(blockId);
                    if (!entry) {
                        entry = { claimed: false, upcomingCount: 0 };
                        table.set(blockId, entry);
                    }
                    const state = p.blockStates && p.blockStates[blockId];
                    if (state === 'claimed') entry.claimed = true;
                    else entry.upcomingCount++;
                }
            }
        }
        this._pathStatusTable = table;
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

    syncFromServer(serverPaths) {
        if (!this.enabled) return;
        const oldBlockIds = new Set();
        for (const p of this.lockedPaths) {
            if (p.blocks) for (const b of p.blocks) oldBlockIds.add(b);
        }

        const paths = Array.isArray(serverPaths) ? serverPaths : [];
        this.lockedPaths = paths;
        this.rebuildPathStatusTable();

        const allBlockIds = new Set(oldBlockIds);
        for (const p of this.lockedPaths) {
            if (p.blocks) for (const b of p.blocks) allBlockIds.add(b);
        }

        if (typeof switchboardRepaint !== 'undefined' && switchboardRepaint) {
            switchboardRepaint.markBlocks(allBlockIds);
        } else {
            const changedSegments = [];
            const changedSwitches = [];
            for (const blockId of allBlockIds) {
                const block = TrackData.getBlock(blockId);
                if (block && block.segmentIds) {
                    for (const segId of block.segmentIds) {
                        const seg = TrackData.getSegment(segId);
                        if (seg && seg.type === 'switch') changedSwitches.push(segId);
                        else changedSegments.push(segId);
                    }
                }
            }
            this.rerender(changedSegments, changedSwitches);
        }

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
                    this.rebuildPathStatusTable();
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
                this.rebuildPathStatusTable();
                this.rerender();
                this.updateStatus('Click an occupied block to start, then a destination block.');
            })
            .catch(() => {
                this.rebuildPathStatusTable();
                this.rerender();
                this.updateStatus('Click an occupied block to start, then a destination block.');
            });
        this._activateIfNeeded();
    },

    enableFromMapping(enablePathing) {
        const wasEnabled = this.enabled;
        if (!this.enabled && enablePathing) this.enable();
        if (!this.enabled) return;
        // Mapping has now been built (switchboard opened), so re-arm the block
        // graph and send the real activation if it hasn't reached the server yet.
        this.buildBlockGraph();
        if (!wasEnabled) return; // enable() already handled activation
        this._activateIfNeeded();
    },

    _activateIfNeeded() {
        if (this._serverActive) return;
        if (!SwitchboardMapper.mapping || SwitchboardMapper.mapping.size === 0) return;
        this._activateWithRetry();
    },

    _activateWithRetry(attempts) {
        if (attempts === undefined) attempts = 0;
        if (attempts > 20) { console.warn('[Pathing] Activation failed'); return; }
        fetch(new URL('/pathing/activate', location), { method: 'POST' })
            .then(resp => {
                if (resp.ok) {
                    this._serverActive = true;
                    console.log('[Pathing] Activation sent');
                } else if (resp.status === 403) {
                    console.warn('[Pathing] No permission');
                }
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
        this.lockedPaths = [];
        this._serverActive = false;
        this.rebuildPathStatusTable();
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

    _blockChipColor(blockId) {
        if (typeof switchboardRenderer !== 'undefined' && switchboardRenderer.resolveBlockColor)
            return switchboardRenderer.resolveBlockColor(blockId, null);
        const block = TrackData.getBlock(blockId);
        if (block && block.occupancyState === 'occupied') return this.MODE_RED;
        return '#666';
    },

    renderPathList() {
        try {
            if (typeof switchboardRepaint !== 'undefined' && switchboardRepaint && !switchboardRepaint.pathsSignatureChanged()) {
                return;
            }
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
                    const color = this._blockChipColor(b);
                    const isOccupied = color === this.MODE_RED || (state === 'occupied');
                    const extra = isOccupied ? 'border:1px solid #fff;' : 'border:1px solid transparent;';
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
