const PathingController = {
    enabled: false,
    state: 'idle',
    startBlockId: null,
    destBlockId: null,
    currentPathBlocks: [],
    currentPathSwitchAssignments: {},
    lockedPaths: [],
    _blockGraph: null,
    _onKeyDown: null,

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

        for (const [blockId, block] of TrackData.blocks) {
            graph.set(blockId, { neighbors: [] });
        }

        const switchToBlocks = new Map();
        for (const [segId, seg] of TrackData.segments) {
            if (seg.type !== 'switch') continue;
            if (!seg.blockId) continue;
            const switchBlockId = seg.blockId;
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
                    if (otherSeg.blockId === switchBlockId) continue;
                    if (!switchToBlocks.has(switchBlockId))
                        switchToBlocks.set(switchBlockId, new Map());
                    const portMap = switchToBlocks.get(switchBlockId);
                    if (!portMap.has(portName))
                        portMap.set(portName, new Set());
                    portMap.get(portName).add(otherSeg.blockId);
                }
            }
        }

        for (const [switchBlockId, portMap] of switchToBlocks) {
            const ports = Array.from(portMap.keys());
            const allBlocks = new Set();
            const blockPorts = new Map();
            for (const [port, blocks] of portMap) {
                for (const bId of blocks) {
                    allBlocks.add(bId);
                    blockPorts.set(bId, port);
                }
            }
            for (const bId of allBlocks) {
                const entry = graph.get(bId);
                if (entry) {
                    const otherBlocks = Array.from(allBlocks).filter(id => id !== bId);
                    for (const otherId of otherBlocks) {
                        if (!entry.neighbors.find(n => n.blockId === otherId)) {
                            entry.neighbors.push({
                                blockId: otherId,
                                viaSwitchBlockId: switchBlockId
                            });
                        }
                    }
                    entry.neighbors.push({
                        blockId: switchBlockId,
                        viaSwitchBlockId: null
                    });
                }
            }
            const swEntry = graph.get(switchBlockId);
            if (swEntry) {
                for (const [port, blocks] of portMap) {
                    for (const bId of blocks) {
                        if (!swEntry.neighbors.find(n => n.blockId === bId)) {
                            swEntry.neighbors.push({
                                blockId: bId,
                                port: port
                            });
                        }
                    }
                }
            }
        }

        this._blockGraph = graph;
        return graph;
    },

    getSwitchAssignment(blockPath) {
        const switchAssignments = {};
        const portNodeNames = [
            { nodeName: 'merging', portName: 'common' },
            { nodeName: 'nl', portName: 'left' },
            { nodeName: 'nr', portName: 'right' }
        ];

        const blockToSwitchPorts = new Map();
        for (const [segId, seg] of TrackData.segments) {
            if (seg.type !== 'switch') continue;
            if (!seg.blockId) continue;
            const swBlockId = seg.blockId;
            for (const { nodeName, portName } of portNodeNames) {
                const nodeId = seg[nodeName];
                if (!nodeId) continue;
                for (const otherSeg of TrackData.segments.values()) {
                    if (otherSeg.type === 'switch') continue;
                    if (otherSeg.n1 !== nodeId && otherSeg.n2 !== nodeId) continue;
                    if (!otherSeg.blockId) continue;
                    if (otherSeg.blockId === swBlockId) continue;
                    if (!blockToSwitchPorts.has(otherSeg.blockId))
                        blockToSwitchPorts.set(otherSeg.blockId, new Map());
                    blockToSwitchPorts.get(otherSeg.blockId).set(swBlockId, portName);
                }
            }
        }

        for (let i = 0; i < blockPath.length - 1; i++) {
            const currentBlock = blockPath[i];
            const nextBlock = blockPath[i + 1];

            const seg = TrackData.getSegmentForBlock ? TrackData.getSegmentForBlock(currentBlock) : null;
            if (!seg || seg.type !== 'switch') continue;

            const prevBlock = i > 0 ? blockPath[i - 1] : null;
            const nextNonSwitchBlock = (i + 2 < blockPath.length) ? blockPath[i + 2] : (i + 1 < blockPath.length ? blockPath[i + 1] : null);

            if (!prevBlock || !nextBlock) continue;

            const ports = blockToSwitchPorts.get(prevBlock);
            const nextPorts = blockToSwitchPorts.get(nextBlock);
            if (!ports || !nextPorts) continue;

            const inPort = ports.get(currentBlock);
            const outPort = nextPorts.get(currentBlock);
            if (!inPort || !outPort) continue;

            const branch = this._neededBranch(inPort, outPort);
            if (branch !== null) {
                switchAssignments[currentBlock] = branch;
            }
        }
        return switchAssignments;
    },

    _neededBranch(inPort, outPort) {
        if (inPort === 'common' && outPort === 'left') return 0;
        if (inPort === 'common' && outPort === 'right') return 1;
        if (outPort === 'common' && inPort === 'left') return 0;
        if (outPort === 'common' && inPort === 'right') return 1;
        if (inPort === 'left' && outPort === 'right') return 1;
        if (inPort === 'right' && outPort === 'left') return 0;
        return null;
    },

    computeBlockPath(fromBlockId, toBlockId) {
        if (!this._blockGraph) this.buildBlockGraph();
        const graph = this._blockGraph;
        if (!graph.has(fromBlockId) || !graph.has(toBlockId)) return null;

        const openSet = new Set([fromBlockId]);
        const cameFrom = new Map();
        const gScore = new Map();
        gScore.set(fromBlockId, 0);

        while (openSet.size > 0) {
            let current = null, currentG = Infinity;
            for (const id of openSet) {
                const g = gScore.get(id) ?? Infinity;
                if (g < currentG) { currentG = g; current = id; }
            }

            if (current === toBlockId) {
                const path = [];
                let node = current;
                while (node) {
                    path.unshift(node);
                    node = cameFrom.get(node);
                }
                const switchAssignments = {};
                for (let i = 0; i < path.length - 1; i++) {
                    const b1 = path[i];
                    const b2 = path[i + 1];
                    const entry1 = graph.get(b1);
                    if (!entry1) continue;
                    const edge = entry1.neighbors.find(n => n.blockId === b2);
                    if (edge && edge.viaSwitchBlockId) {
                        if (!switchAssignments[edge.viaSwitchBlockId]) {
                            const prevBlock = i > 0 ? path[i - 1] : null;
                            const nextBlock = i + 2 < path.length ? path[i + 2] : null;
                            const ports = this._getBlockSwitchPorts(b1, edge.viaSwitchBlockId);
                            const nextPorts = nextBlock ? this._getBlockSwitchPorts(nextBlock, edge.viaSwitchBlockId) : null;
                            if (ports && nextPorts) {
                                const branch = this._neededBranch(ports, nextPorts);
                                if (branch !== null)
                                    switchAssignments[edge.viaSwitchBlockId] = branch;
                            }
                        }
                    }
                }
                return { blocks: path, switchAssignments };
            }

            openSet.delete(current);
            const entry = graph.get(current);
            if (!entry) continue;

            for (const neighbor of entry.neighbors) {
                const nbrId = neighbor.blockId;
                const tentG = (gScore.get(current) ?? Infinity) + 1;
                if (tentG < (gScore.get(nbrId) ?? Infinity)) {
                    cameFrom.set(nbrId, current);
                    gScore.set(nbrId, tentG);
                    openSet.add(nbrId);
                }
            }
        }
        return null;
    },

    _getBlockSwitchPorts(blockId, switchBlockId) {
        for (const [segId, seg] of TrackData.segments) {
            if (seg.type !== 'switch') continue;
            if (seg.blockId !== switchBlockId) continue;
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
                    if (otherSeg.blockId === blockId) return portName;
                }
            }
        }
        return null;
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
        if (this.state === 'idle') {
            this.startBlockId = blockId;
            this.state = 'selectingDest';
            this.updateStatus(`Start block: ${blockId}. Click a destination block.`);
            this.rerender();
        } else if (this.state === 'selectingDest') {
            this.destBlockId = blockId;
            this.state = 'preview';
            const result = this.computeBlockPath(this.startBlockId, this.destBlockId);
            if (result) {
                this.currentPathBlocks = result.blocks;
                this.currentPathSwitchAssignments = result.switchAssignments;
                this.rerender();
                this.confirmPath();
            } else {
                this.updateStatus('No path found between those blocks.');
                this.state = 'selectingDest';
            }
        } else if (this.state === 'preview') {
            this.destBlockId = blockId;
            const result = this.computeBlockPath(this.startBlockId, this.destBlockId);
            if (result) {
                this.currentPathBlocks = result.blocks;
                this.currentPathSwitchAssignments = result.switchAssignments;
                this.rerender();
                this.confirmPath();
            } else {
                this.updateStatus('No path found.');
            }
        }
    },

    confirmPath() {
        if (this.currentPathBlocks.length === 0) return;

        const pathEntry = {
            blocks: this.currentPathBlocks,
            startBlock: this.startBlockId,
            destBlock: this.destBlockId,
            switchAssignments: this.currentPathSwitchAssignments
        };

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
                this._resetSelection();
                this.rerender();
                this.updateStatus(`Path locked (${this.currentPathBlocks.length} blocks). ${this.lockedPaths.length} path(s) active.`);
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
            return { color: this.MODE_YELLOW };
        }

        if (this.state === 'selectingDest' && blockId === this.startBlockId) {
            return { color: this.MODE_BLUE };
        }

        if (this.state === 'preview') {
            if (blockId === this.startBlockId) return { color: this.MODE_BLUE };
            if (blockId === this.destBlockId) return { color: this.MODE_YELLOW };
        }

        return null;
    },

    getSwitchRimColor(swId) {
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

    onContextMenuSwitch(switchId) {},
    onSwitchHover(switchId) {},
    onSwitchHoverEnd() {},

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
