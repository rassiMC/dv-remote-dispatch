const PathingController = {
    enabled: false,
    state: 'off',
    originSwitchId: null,
    destinationSwitchId: null,
    waypoints: new Set(),
    currentPath: [],
    pathSegments: [],
    overlayGroup: null,
    waypointsGroup: null,
    waypointMarkers: new Map(),
    recentlyAligned: new Map(),
    _clickLocking: false,
    _onKeyDown: null,

    MODE_YELLOW: '#ccbb33',
    MODE_GREEN: '#208020',
    MODE_RED: '#a02020',

    get showGrayClear() {
        return this.enabled;
    },

    _resetState() {
        this.state = 'off';
        this._clickLocking = false;
        this.originSwitchId = null;
        this.destinationSwitchId = null;
        this.waypoints.clear();
        this.currentPath = [];
        this.pathSegments = [];
        this.clearOverlay();
        this.clearWaypoints();
        this.recentlyAligned.clear();
    },

    clearAll() {
        this._resetState();
        this.updateStatus('');
    },

    enable() {
        if (this.enabled) return;
        this.enabled = true;
        this._attachKeyHandler();
        this.updateStatus('Right-click a switch to begin pathing');
        this.rerender();
    },

    disable() {
        if (!this.enabled) return;
        this.enabled = false;
        this._detachKeyHandler();
        this._resetState();
        this.rerender();
    },

    _attachKeyHandler() {
        if (this._onKeyDown) return;
        this._onKeyDown = e => {
            if (e.key === 'Escape' && this.state !== 'off') {
                this.clearAll();
                this.updateStatus('Path cancelled. Right-click a switch to begin.');
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

    startFrom(switchId) {
        if (!this.enabled) return;
        this._resetState();
        this.state = 'selectingOrigin';
        this.originSwitchId = switchId;
        this.renderOriginOverlay();
        this.updateStatus('Origin set. Hover a switch to preview path, click to lock. Click tracks for waypoints.');
    },

    onSwitchHover(switchId) {
        if (this.state !== 'selectingOrigin' && this.state !== 'preview') return;
        if (switchId === this.originSwitchId) return;
        const result = this.computePath(this.originSwitchId, switchId);
        if (result && result.switches.length > 0) {
            this.state = 'preview';
            this.destinationSwitchId = switchId;
            this.currentPath = result.switches;
            this.pathSegments = result.segments;
            this.renderOverlay('preview');
            this.updateStatus('Preview: click to lock this path, or hover another switch');
        } else {
            this.renderOriginOverlay();
            this.updateStatus('No path to that switch');
        }
    },

    onSwitchHoverEnd() {
        if (this.state !== 'preview') return;
        if (this._clickLocking) return;
        this.state = 'selectingOrigin';
        this.destinationSwitchId = null;
        this.currentPath = [];
        this.pathSegments = [];
        this.renderOriginOverlay();
        this.updateStatus('Origin set. Hover a switch to preview path, click to lock.');
    },

    onSwitchClick(switchId) {
        if (this.state !== 'selectingOrigin' && this.state !== 'preview') return;
        if (switchId === this.originSwitchId) return;

        this._clickLocking = true;
        setTimeout(() => { this._clickLocking = false; }, 100);

        const result = this.computePath(this.originSwitchId, switchId);
        if (result && result.switches.length > 0) {
            this.state = 'locked';
            this.destinationSwitchId = switchId;
            this.currentPath = result.switches;
            this.pathSegments = result.segments;
            this.renderOverlay('locked');
            this.autoAlign();
            this.updateStatus(`Path locked (${result.switches.length} switches, ${result.segments.length} segments). Esc to cancel.`);
        }
    },

    onSegmentClick(segmentId) {
        if (this.state !== 'selectingOrigin' && this.state !== 'preview') return;
        const seg = TrackData.getSegment(segmentId);
        if (!seg || seg.type === 'switch') return;
        if (this.waypoints.has(segmentId)) {
            this.waypoints.delete(segmentId);
            this.removeWaypointMarker(segmentId);
        } else {
            this.waypoints.add(segmentId);
            this.addWaypointMarker(segmentId);
        }
        if (this.state === 'preview' && this.destinationSwitchId) {
            const result = this.computePath(this.originSwitchId, this.destinationSwitchId);
            if (result) {
                this.currentPath = result.switches;
                this.pathSegments = result.segments;
                this.renderOverlay('preview');
            }
        }
        this.updateStatus(`Waypoints: ${this.waypoints.size} (Esc to cancel)`);
    },

    segmentsToSwitches(segmentIds) {
        const result = [];
        const graph = SwitchboardMapper.switchboardGraph;
        if (!graph) return result;
        for (const segId of segmentIds) {
            const seg = TrackData.getSegment(segId);
            if (!seg) continue;
            for (const [swId, entry] of graph) {
                if (entry.merging === seg.n1 || entry.nl === seg.n1 || entry.nr === seg.n1 ||
                    entry.merging === seg.n2 || entry.nl === seg.n2 || entry.nr === seg.n2) {
                    if (!result.includes(swId)) result.push(swId);
                    break;
                }
            }
        }
        return result;
    },

    computePath(fromId, toId) {
        const graph = SwitchboardMapper.switchboardGraph;
        if (!graph || !graph.has(fromId) || !graph.has(toId)) return null;

        const wpSwitches = this.segmentsToSwitches(Array.from(this.waypoints));
        const allWaypoints = [fromId, ...wpSwitches, toId].filter(Boolean);

        let allPathSwitches = [];
        let allPathSegments = [];
        let prevEntryPort = null;
        for (let i = 0; i < allWaypoints.length - 1; i++) {
            const result = this._aStar(allWaypoints[i], allWaypoints[i + 1], prevEntryPort);
            if (!result) return null;

            const lastSw = result.switches[result.switches.length - 1];
            const prevSw = result.switches.length >= 2 ? result.switches[result.switches.length - 2] : null;
            prevEntryPort = prevSw ? this._entryPortOf(prevSw, lastSw) : null;

            if (i > 0) result.switches.shift();
            allPathSwitches.push(...result.switches);
            allPathSegments.push(...result.segments);
        }
        const uniqueSwitches = [];
        for (const sw of allPathSwitches) {
            if (uniqueSwitches[uniqueSwitches.length - 1] !== sw) uniqueSwitches.push(sw);
        }
        const uniqueSegments = [];
        for (const seg of allPathSegments) {
            if (!uniqueSegments.includes(seg)) uniqueSegments.push(seg);
        }
        return { switches: uniqueSwitches, segments: uniqueSegments };
    },

    _getCentroid(swId) {
        const sw = TrackData.getSegment(swId);
        if (!sw || sw.type !== 'switch') return null;
        const merging = TrackData.getNode(sw.merging);
        const nl = TrackData.getNode(sw.nl);
        const nr = TrackData.getNode(sw.nr);
        if (!merging || !nl || !nr) return null;
        return { x: (merging.x + nl.x + nr.x) / 3, y: (merging.y + nl.y + nr.y) / 3 };
    },

    _traceSegments(fromNodeId, toNodeId) {
        const visited = new Set();
        const queue = [{ nodeId: fromNodeId, path: [] }];
        visited.add(fromNodeId);
        while (queue.length > 0) {
            const { nodeId, path } = queue.shift();
            if (nodeId === toNodeId) return path;
            const segs = TrackData.getSegmentsForNode(nodeId);
            for (const seg of segs) {
                if (seg.type === 'switch') continue;
                const other = seg.n1 === nodeId ? seg.n2 : seg.n1;
                if (visited.has(other)) continue;
                visited.add(other);
                queue.push({ nodeId: other, path: [...path, seg.id] });
            }
        }
        return null;
    },

    _edgeCost(swId, neighborSwId) {
        const entry = SwitchboardMapper.switchboardGraph.get(swId);
        if (!entry) return 1;
        const neighbor = entry.neighbors.find(n => n.switchId === neighborSwId);
        if (!neighbor) return 1;
        const segs = this._traceSegments(neighbor.fromNodeId, neighbor.viaNodeId);
        if (!segs) return 1;
        for (const segId of segs) {
            const block = TrackData.getBlockForSegment(segId);
            if (block && block.occupancyState === 'occupied') return 1000;
        }
        return 1;
    },

    _traceFullPath(switches) {
        const allSegments = [];
        for (let i = 0; i < switches.length - 1; i++) {
            const entry = SwitchboardMapper.switchboardGraph.get(switches[i]);
            if (!entry) continue;
            const neighbor = entry.neighbors.find(n => n.switchId === switches[i + 1]);
            if (!neighbor) continue;
            const segs = this._traceSegments(neighbor.fromNodeId, neighbor.viaNodeId);
            if (segs) allSegments.push(...segs);
        }
        return allSegments;
    },

    _validExits(entryPort) {
        if (!entryPort) return ['left', 'right', 'common'];
        if (entryPort === 'common') return ['left', 'right'];
        return ['common'];
    },

    _entryPortOf(currentSwId, neighborSwId) {
        const entry = SwitchboardMapper.switchboardGraph.get(neighborSwId);
        if (!entry) return null;
        const backLink = entry.neighbors.find(n => n.switchId === currentSwId);
        return backLink ? backLink.port : null;
    },

    _aStar(fromId, toId, fromEntryPort) {
        const graph = SwitchboardMapper.switchboardGraph;
        if (!graph.has(fromId) || !graph.has(toId)) return null;
        const fromC = this._getCentroid(fromId);
        const toC = this._getCentroid(toId);
        if (!fromC || !toC) return null;

        const _h = (a, b) => {
            const dx = a.x - b.x, dy = a.y - b.y;
            return Math.sqrt(dx * dx + dy * dy);
        };

        const openSet = new Set([fromId]);
        const cameFrom = new Map();
        const entryPorts = new Map();
        if (fromEntryPort) entryPorts.set(fromId, fromEntryPort);
        const gScore = new Map(); gScore.set(fromId, 0);
        const fScore = new Map(); fScore.set(fromId, _h(fromC, toC));

        while (openSet.size > 0) {
            let current = null, currentF = Infinity;
            for (const id of openSet) {
                const f = fScore.get(id) ?? Infinity;
                if (f < currentF) { currentF = f; current = id; }
            }
            if (current === toId) {
                const pathSwitches = [];
                let node = current;
                while (node) { pathSwitches.unshift(node); node = cameFrom.get(node); }
                const pathSegments = pathSwitches.length > 1 ? this._traceFullPath(pathSwitches) : [];
                return { switches: pathSwitches, segments: pathSegments };
            }
            openSet.delete(current);
            const entry = graph.get(current);
            if (!entry) continue;

            const entryPort = entryPorts.get(current);

            for (const nbr of entry.neighbors) {
                const nbrId = nbr.switchId;
                const exitPort = nbr.port;
                const validExits = this._validExits(entryPort);
                if (!validExits.includes(exitPort)) continue;

                const cost = this._edgeCost(current, nbrId);
                const tentativeG = (gScore.get(current) ?? Infinity) + cost;
                if (tentativeG < (gScore.get(nbrId) ?? Infinity)) {
                    cameFrom.set(nbrId, current);
                    entryPorts.set(nbrId, this._entryPortOf(current, nbrId));
                    gScore.set(nbrId, tentativeG);
                    const nbrC = this._getCentroid(nbrId);
                    if (nbrC) fScore.set(nbrId, tentativeG + _h(nbrC, toC));
                    openSet.add(nbrId);
                }
            }
        }
        return null;
    },

    getOccupiedSegments() {
        const occupied = new Set();
        for (const segId of this.pathSegments) {
            const block = TrackData.getBlockForSegment(segId);
            if (block && block.occupancyState === 'occupied') occupied.add(segId);
        }
        return occupied;
    },

    autoAlign() {
        if (this.state !== 'locked') return;
        const toToggle = [];
        for (const swId of this.currentPath) {
            if (swId === this.originSwitchId || swId === this.destinationSwitchId) continue;
            const jIdx = SwitchboardMapper.getIngameJunctionIndex(swId);
            if (jIdx === null) continue;
            const ingameData = SwitchboardMapper.ingameGraph?.get(jIdx);
            if (!ingameData) continue;

            const pIdx = this.currentPath.indexOf(swId);
            const prevSwId = this.currentPath[pIdx - 1];
            const nextSwId = this.currentPath[pIdx + 1];
            if (!prevSwId || !nextSwId) continue;

            const entry = SwitchboardMapper.switchboardGraph.get(swId);
            if (!entry) continue;
            const prevNbr = entry.neighbors.find(n => n.switchId === prevSwId);
            const nextNbr = entry.neighbors.find(n => n.switchId === nextSwId);
            if (!prevNbr || !nextNbr) continue;

            const neededBranch = this._neededBranch(prevNbr.port, nextNbr.port);
            if (neededBranch === null) continue;

            if (ingameData.currentBranch === neededBranch) {
                this.recentlyAligned.set(swId, Date.now());
                continue;
            }
            toToggle.push({ swId, jIdx, neededBranch });
        }

        Promise.allSettled(toToggle.map(({ swId, jIdx, neededBranch }) =>
            fetch(new URL(`/junction/${jIdx}/toggle`, location), { method: 'POST' })
                .then(resp => resp.ok ? resp.text() : null)
                .then(newBranch => {
                    if (newBranch !== null) {
                        this.recentlyAligned.set(swId, Date.now());
                        const ingameData = SwitchboardMapper.ingameGraph?.get(jIdx);
                        if (ingameData) ingameData.currentBranch = parseInt(newBranch);
                    }
                })
        )).then(() => {
            this.rerender();
            this.renderOverlay('locked');
        });

        this.rerender();
        this.renderOverlay('locked');
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

    checkManualAlignment(swId, newBranch) {
        if (this.state !== 'locked') return;
        if (!this.currentPath.includes(swId)) return;
        const pIdx = this.currentPath.indexOf(swId);
        const prevSwId = this.currentPath[pIdx - 1];
        const nextSwId = this.currentPath[pIdx + 1];
        if (!prevSwId || !nextSwId) return;
        const entry = SwitchboardMapper.switchboardGraph.get(swId);
        if (!entry) return;
        const prevNbr = entry.neighbors.find(n => n.switchId === prevSwId);
        const nextNbr = entry.neighbors.find(n => n.switchId === nextSwId);
        if (!prevNbr || !nextNbr) return;
        const neededBranch = this._neededBranch(prevNbr.port, nextNbr.port);
        if (neededBranch === null) return;
        if (newBranch === neededBranch) {
            this.recentlyAligned.set(swId, Date.now());
            this.rerender();
            this.renderOverlay('locked');
        }
    },

    getOverridesForSegment(segId) {
        if (this.state === 'off') return null;
        if (!this.pathSegments.includes(segId)) return null;
        const block = TrackData.getBlockForSegment(segId);
        if (block && block.occupancyState === 'occupied') return { color: this.MODE_RED };
        if (this.state === 'locked') return { color: this.MODE_GREEN };
        return { color: this.MODE_YELLOW };
    },

    getSwitchRimColor(swId) {
        if (this.state === 'selectingOrigin' && swId === this.originSwitchId) return this.MODE_YELLOW;
        if (this.state === 'preview' && this.currentPath.includes(swId)) return this.MODE_YELLOW;
        if (this.state === 'locked' && this.currentPath.includes(swId)) {
            if (swId === this.originSwitchId || swId === this.destinationSwitchId) return null;
            if (this.recentlyAligned.has(swId)) return this.MODE_GREEN;
            const status = this._alignmentStatus(swId);
            if (status === 'aligned') return this.MODE_GREEN;
            if (status === 'misaligned') return this.MODE_RED;
        }
        return null;
    },

    _alignmentStatus(swId) {
        const jIdx = SwitchboardMapper.getIngameJunctionIndex(swId);
        if (jIdx === null) return null;
        const ingameData = SwitchboardMapper.ingameGraph?.get(jIdx);
        if (!ingameData) return null;
        const pIdx = this.currentPath.indexOf(swId);
        const prevSwId = this.currentPath[pIdx - 1];
        const nextSwId = this.currentPath[pIdx + 1];
        if (!prevSwId || !nextSwId) return null;
        const entry = SwitchboardMapper.switchboardGraph.get(swId);
        if (!entry) return null;
        const prevNbr = entry.neighbors.find(n => n.switchId === prevSwId);
        const nextNbr = entry.neighbors.find(n => n.switchId === nextSwId);
        if (!prevNbr || !nextNbr) return null;
        const needed = this._neededBranch(prevNbr.port, nextNbr.port);
        if (needed === null) return null;
        return ingameData.currentBranch === needed ? 'aligned' : 'misaligned';
    },

    // Overlay rendering
    getOverlayGroup() {
        if (!this.overlayGroup) {
            this.overlayGroup = L.featureGroup().addTo(switchboardRenderer.map);
        }
        return this.overlayGroup;
    },

    clearOverlay() {
        if (this.overlayGroup) {
            switchboardRenderer.map.removeLayer(this.overlayGroup);
            this.overlayGroup = null;
        }
    },

    clearWaypoints() {
        for (const m of this.waypointMarkers.values()) {
            switchboardRenderer.map.removeLayer(m);
        }
        this.waypointMarkers.clear();
    },

    renderOriginOverlay() {
        this.clearOverlay();
        if (!this.originSwitchId) return;
        this._addSwitchRimToOverlay(this.originSwitchId, this.MODE_YELLOW);
    },

    renderOverlay(mode) {
        this.clearOverlay();
        if (!this.originSwitchId || this.currentPath.length === 0) return;

        const group = this.getOverlayGroup();
        const occupiedSegs = this.getOccupiedSegments();

        for (const segId of this.pathSegments) {
            const seg = TrackData.getSegment(segId);
            if (!seg) continue;
            let n1, n2;
            if (seg.type === 'switch') {
                n1 = TrackData.getNode(seg.merging);
                n2 = seg.state === 0 ? TrackData.getNode(seg.nl) : TrackData.getNode(seg.nr);
            } else {
                n1 = TrackData.getNode(seg.n1);
                n2 = TrackData.getNode(seg.n2);
            }
            if (!n1 || !n2) continue;

            let color;
            if (occupiedSegs.has(segId)) color = this.MODE_RED;
            else if (mode === 'locked') color = this.MODE_GREEN;
            else color = this.MODE_YELLOW;

            L.polyline([
                switchboardRenderer.coordsToLatLng(n1.x, n1.y),
                switchboardRenderer.coordsToLatLng(n2.x, n2.y)
            ], {
                color, weight: 6, opacity: mode === 'locked' ? 0.9 : 0.7, interactive: false
            }).addTo(group);
        }

        this._addSwitchRimToOverlay(this.originSwitchId, this.MODE_YELLOW);

        for (const swId of this.currentPath) {
            if (swId === this.originSwitchId) continue;
            if (mode === 'preview') {
                this._addSwitchRimToOverlay(swId, this.MODE_YELLOW);
            } else if (mode === 'locked') {
                if (swId === this.destinationSwitchId) continue;
                if (this.recentlyAligned.has(swId)) {
                    this._addSwitchRimToOverlay(swId, this.MODE_GREEN);
                } else {
                    const status = this._alignmentStatus(swId);
                    if (status === 'aligned') this._addSwitchRimToOverlay(swId, this.MODE_GREEN);
                    else if (status === 'misaligned') this._addSwitchRimToOverlay(swId, this.MODE_RED);
                }
            }
        }
    },

    _addSwitchRimToOverlay(swId, color) {
        const bounds = switchboardRenderer.switchBounds.get(swId);
        if (!bounds) return;
        const latlngBounds = L.latLngBounds([
            switchboardRenderer.coordsToLatLng(bounds.minX, bounds.minY),
            switchboardRenderer.coordsToLatLng(bounds.maxX, bounds.maxY)
        ]);
        L.rectangle(latlngBounds, {
            color, weight: 3, fillColor: '#102020', fillOpacity: 0.7, interactive: false
        }).addTo(this.getOverlayGroup());
    },

    addWaypointMarker(segmentId) {
        if (this.waypointMarkers.has(segmentId)) return;
        const seg = TrackData.getSegment(segmentId);
        if (!seg) return;
        const n1Id = seg.n1 || seg.merging;
        const n2Id = seg.n2 || seg.nl;
        const n1 = TrackData.getNode(n1Id);
        const n2 = TrackData.getNode(n2Id);
        if (!n1 || !n2) return;
        const mx = (n1.x + n2.x) / 2, my = (n1.y + n2.y) / 2;
        const marker = L.circle(switchboardRenderer.coordsToLatLng(mx, my), {
            radius: 0.35,
            fillColor: '#ff9900',
            fillOpacity: 1,
            color: '#fff',
            weight: 2,
            interactive: false
        }).addTo(switchboardRenderer.map);
        this.waypointMarkers.set(segmentId, marker);
    },

    removeWaypointMarker(segmentId) {
        const marker = this.waypointMarkers.get(segmentId);
        if (marker) {
            switchboardRenderer.map.removeLayer(marker);
            this.waypointMarkers.delete(segmentId);
        }
    },

    rerender() {
        if (typeof switchboardRenderer !== 'undefined' && switchboardRenderer) {
            switchboardRenderer.rerenderAllSegments();
            switchboardRenderer.rerenderSwitches();
        }
    },

    updateStatus(msg) {
        const el = document.getElementById('pathingStatus');
        if (el) el.textContent = msg;
    }
};
