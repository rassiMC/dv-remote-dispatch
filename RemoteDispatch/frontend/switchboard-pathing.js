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

        for (const [segId, seg] of TrackData.segments) {
            if (seg.type !== 'switch') continue;
            if (!seg.blockId) continue;
            const swBlockId = seg.blockId;
            const portNodeNames = [
                { nodeName: 'merging', portName: 'common' },
                { nodeName: 'nl', portName: 'left' },
                { nodeName: 'nr', portName: 'right' }
            ];
            for (const { nodeName, portName } of portNodeNames) {
                const nodeId = seg[nodeName];
                if (!nodeId) continue;
                for (const otherSeg of TrackData.segments.values()) {
                    if (otherSeg.type === 'switch') continue;
                    if (otherSeg.n1 !== nodeId && otherSeg.n2 !== nodeId) continue;
                    if (!otherSeg.blockId) continue;
                    if (otherSeg.blockId === swBlockId) continue;

                    const swEntry = graph.get(swBlockId);
                    if (swEntry && !swEntry.neighbors.find(n => n.blockId === otherSeg.blockId))
                        swEntry.neighbors.push({ blockId: otherSeg.blockId, port: portName });

                    const otherEntry = graph.get(otherSeg.blockId);
                    if (otherEntry && !otherEntry.neighbors.find(n => n.blockId === swBlockId))
                        otherEntry.neighbors.push({ blockId: swBlockId, port: portName, nodeId: nodeId });

                    const key = `${otherSeg.blockId}@${swBlockId}`;
                    if (!this._blockSwitchPorts.has(key))
                        this._blockSwitchPorts.set(key, portName);
                }
            }
        }

        this._blockGraph = graph;
        return graph;
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

                    const isSwitch = this._blockSwitchPorts.has(`${prevBlock}@${blockId}`) ||
                        this._blockSwitchPorts.has(`${nextBlock}@${blockId}`);
                    if (!isSwitch) continue;

                    const inPort = this._getPortForBlockAtSwitch(prevBlock, blockId);
                    const outPort = this._getPortForBlockAtSwitch(nextBlock, blockId);
                    if (!inPort || !outPort) continue;

                    const branch = inPort === 'common' && outPort === 'left' ? 0 :
                        inPort === 'common' && outPort === 'right' ? 1 :
                        outPort === 'common' && inPort === 'left' ? 0 :
                        outPort === 'common' && inPort === 'right' ? 1 :
                        inPort === 'left' && outPort === 'right' ? 1 :
                        inPort === 'right' && outPort === 'left' ? 0 : null;
                    if (branch !== null)
                        switchAssignments[blockId] = branch;
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
        if (this.state !== 'selectingDest') return;
        if (this.currentPathBlocks.length > 0) {
            const oldBlocks = this.currentPathBlocks;
            this.currentPathBlocks = [];
            this.currentPathSwitchAssignments = {};
            this._updateSegmentColors(oldBlocks);
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
        const pathBlocks = blocks.slice();
        const pathAssignments = Object.assign({}, switchAssignments);

        const pathEntry = {
            blocks: pathBlocks,
            startBlock: startBlock,
            destBlock: destBlock,
            switchAssignments: pathAssignments,
            signalIds: signalIds
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
                pathEntry.id = data.id;
                this.lockedPaths.push(pathEntry);
                this._updateSegmentColors(pathBlocks);
                this.updateStatus(`Path locked (${pathBlocks.length} blocks). ${this.lockedPaths.length} path(s) active.`);
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
                    const block = TrackData.getBlock(blockId);
                    if (block && block.occupancyState === 'occupied') return { color: this.MODE_RED };
                    return { color: this.MODE_GREEN };
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
                    const block = TrackData.getBlock(blockId);
                    if (block && block.occupancyState === 'occupied') return this.MODE_RED;
                    return this.MODE_GREEN;
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
                const count = p.blocks ? p.blocks.length : 0;
                return `<div style="display:flex;align-items:center;gap:6px;margin:4px 0;">
                    <span style="color:#4c4;font-size:16px">\u2713</span>
                    <span style="font-size:14px">${label}</span>
                    <span style="color:#666;font-size:12px;margin-left:auto">${count}</span>
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
