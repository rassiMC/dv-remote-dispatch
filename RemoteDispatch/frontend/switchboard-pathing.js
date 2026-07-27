const PathingController = {
    enabled: false,
    state: 'idle',
    lockedPaths: [],
    originSwitchId: null,
    destinationSwitchId: null,
    waypoints: new Set(),
    currentPath: [],
    pathSegments: [],
    waypointMarkers: new Map(),
    recentlyAligned: new Map(),
    _clickLocking: false,
    _onKeyDown: null,
    _lastSegments: new Set(),
    _lastSwitches: new Set(),
    editingPathIndex: null,

    MODE_YELLOW: '#ffdd44',
    MODE_BLUE: '#4488ff',
    MODE_GREEN: '#208020',
    MODE_RED: '#a02020',

    get showGrayClear() {
        return this.enabled;
    },

    _resetSelection() {
        this.state = 'idle';
        this._clickLocking = false;
        this.originSwitchId = null;
        this.destinationSwitchId = null;
        this.waypoints.clear();
        this.currentPath = [];
        this.pathSegments = [];
        this.clearWaypoints();
    },

    syncFromServer(serverPaths) {
        if (!this.enabled) return;
        if (this.editingPathIndex !== null) return;
        const oldSegs = this._currentSegments();
        const oldSwitches = this._currentSwitches();

        const paths = Array.isArray(serverPaths) ? serverPaths : [];

        const alignedSwitches = new Set();
        for (const p of paths) {
            if (p.switches) {
                for (const swId of p.switches) {
                    if (this.recentlyAligned.has(swId)) {
                        alignedSwitches.add(swId);
                    }
                }
            }
        }
        this.recentlyAligned.clear();
        for (const swId of alignedSwitches) {
            this.recentlyAligned.set(swId, Date.now());
        }

        this.lockedPaths = paths;
        this._rebuildAllQueues();
        this._rerenderDiff(oldSegs, oldSwitches);
        this._rerenderChanged();
        this.renderPathList();
    },

    _rebuildAllQueues() {
        const graph = SwitchboardMapper.switchboardGraph;
        if (!graph) return;
        for (const [, entry] of graph) {
            entry._pathQueue = [];
            entry._lastAspects = {};
            entry._wasOccupied = false;
        }
        for (const p of this.lockedPaths) {
            if (!p.switches) continue;
            for (const swId of p.switches) {
                const entry = graph.get(swId);
                if (entry) {
                    if (!entry._pathQueue) entry._pathQueue = [];
                    if (!entry._pathQueue.includes(p.id)) {
                        entry._pathQueue.push(p.id);
                    }
                }
            }
        }
        for (const [swId, entry] of graph) {
            if (!entry._pathQueue || entry._pathQueue.length === 0) continue;
            const headId = entry._pathQueue[0];
            const headPath = this.lockedPaths.find(p => p.id === headId);
            if (headPath) {
                this._applyPathToSwitch(swId, headPath);
            }
        }
    },

    clearAll() {
        if (this.lockedPaths.length === 0) {
            this._resetSelection();
            this.editingPathIndex = null;
            this.recentlyAligned.clear();
            this._lastSegments.clear();
            this._lastSwitches.clear();
            this.rerender();
            this.updateStatus('');
            return;
        }
        if (!confirm('Clear all paths? This cannot be undone.')) return;
        fetch(new URL('/path', location), { method: 'DELETE' })
            .then(resp => {
                if (resp.ok) {
                    this.lockedPaths = [];
                    this._rebuildAllQueues();
                    this.recentlyAligned.clear();
                    this.editingPathIndex = null;
                    this._resetSelection();
                    this._lastSegments.clear();
                    this._lastSwitches.clear();
                    this.rerender();
                    this.updateStatus('All paths cleared. Right-click a switch to begin.');
                } else if (resp.status === 403) {
                    this.updateStatus('Permission denied: junction & signal control required.');
                }
            });
    },

    enable() {
        if (this.enabled) return;
        this.enabled = true;
        this._attachKeyHandler();
        this.updateStatus('Loading paths...');
        fetch(new URL('/path', location))
            .then(resp => resp.json())
            .then(data => {
                this.lockedPaths = Array.isArray(data) ? data : [];
                this._rebuildAllQueues();
                this.rerender();
                this.updateStatus('Right-click a switch to begin pathing');
            })
            .catch(() => {
                this.rerender();
                this.updateStatus('Right-click a switch to begin pathing');
            });
        this._activateWithRetry();
    },

    _activateWithRetry(attempts) {
        if (attempts === undefined) attempts = 0;
        if (attempts > 20) {
            console.warn('[Pathing] Activation failed after retries');
            return;
        }
        fetch(new URL('/pathing/activate', location), { method: 'POST' })
            .then(resp => {
                if (resp.ok) console.log('[Pathing] Activation sent');
                else if (resp.status === 403) console.warn('[Pathing] No permission for activation');
            })
            .catch(() => {
                setTimeout(() => this._activateWithRetry(attempts + 1), 1000);
            });
    },

    disable() {
        if (!this.enabled) return;
        this.enabled = false;
        this._detachKeyHandler();
        this.editingPathIndex = null;
        this._resetSelection();
        this._lastSegments.clear();
        this._lastSwitches.clear();
        this.rerender();
        this.updateStatus('disabled');
    },

    _attachKeyHandler() {
        if (this._onKeyDown) return;
        this._onKeyDown = e => {
            if (e.key === 'Escape') {
                if (this.state !== 'idle') {
                    if (this.editingPathIndex !== null) {
                        this._editBackup = null;
                        this.editingPathIndex = null;
                    }
                    this._resetSelection();
                    this.rerender();
                    this.updateStatus('Cancelled. Right-click a switch to begin.');
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

    onContextMenuSwitch(switchId) {
        if (!this.enabled) return;

        if (this.state === 'selectingOrigin' || this.state === 'preview') {
            if (switchId !== this.originSwitchId) {
                this.onSwitchClick(switchId);
                return;
            }
        }

        const existingPath = this._switchInPaths(switchId);
        if (existingPath) {
            if (switchId === existingPath.originSwitchId) {
                this.deletePath(existingPath);
                return;
            }
            if (switchId === existingPath.destinationSwitchId) {
                this.startEdit(existingPath);
                return;
            }
        }

        this.startFrom(switchId);
    },

    startFrom(switchId) {
        if (!this.enabled) return;
        const oldSegs = this._currentSegments();
        const oldSwitches = this._currentSwitches();
        this._resetSelection();
        this.editingPathIndex = null;
        this.state = 'selectingOrigin';
        this.originSwitchId = switchId;
        this._rerenderDiff(oldSegs, oldSwitches);
        this._rerenderChanged();
        this.updateStatus('Origin set. Hover a switch to preview path, click to lock. Click tracks for waypoints.');
    },

    onSwitchHover(switchId) {
        if (this.state !== 'selectingOrigin' && this.state !== 'preview') return;
        if (switchId === this.originSwitchId) return;
        const oldSegs = this._currentSegments();
        const oldSwitches = this._currentSwitches();
        const result = this.computePath(this.originSwitchId, switchId);
        if (result && result.switches.length > 0) {
            this.state = 'preview';
            this.destinationSwitchId = switchId;
            this.currentPath = result.switches;
            this.pathSegments = result.segments;
            this._rerenderDiff(oldSegs, oldSwitches);
            this._rerenderChanged();
            this.updateStatus('Preview: click to lock this path, or hover another switch');
        } else {
            this._rerenderDiff(oldSegs, oldSwitches);
            this._rerenderChanged();
            this.updateStatus('No path to that switch');
        }
    },

    onSwitchHoverEnd() {
        if (this.state !== 'preview') return;
        const oldSegs = this._currentSegments();
        const oldSwitches = this._currentSwitches();
        this.state = 'selectingOrigin';
        this.destinationSwitchId = null;
        this.currentPath = [];
        this.pathSegments = [];
        this._rerenderDiff(oldSegs, oldSwitches);
        this._rerenderChanged();
        this.updateStatus('Origin set. Hover a switch to preview path, click to lock.');
    },

    onSwitchClick(switchId) {
        if (this.state !== 'selectingOrigin' && this.state !== 'preview') return;
        if (switchId === this.originSwitchId) return;

        const oldSegs = this._currentSegments();
        const oldSwitches = this._currentSwitches();
        const result = this.computePath(this.originSwitchId, switchId);
        if (result && result.switches.length > 0) {
            const signalIds = this._pathSignalIds(result.connections);
            const pathEntry = {
                originSwitchId: this.originSwitchId,
                destinationSwitchId: switchId,
                switches: result.switches,
                segments: result.segments,
                connections: result.connections,
                signalIds: signalIds
            };

            const body = { ...pathEntry };

            if (this.editingPathIndex !== null) {
                const oldPathId = this._editOldPathId;
                this._removePathFromQueues(oldPathId);
                this.editingPathIndex = null;
                this._editOldPathId = null;
                this._resetSelection();
                this._rerenderDiff(oldSegs, oldSwitches);
                this._rerenderChanged();
                const removePromise = oldPathId
                    ? fetch(new URL(`/path/${oldPathId}`, location), { method: 'DELETE' })
                    : Promise.resolve();
                removePromise
                    .then(() => fetch(new URL('/path', location), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body)
                    }))
                    .then(resp => resp.ok ? resp.json() : null)
                    .then(data => {
                        if (data && data.id) {
                            pathEntry.id = data.id;
                            this._pushPathToQueues(pathEntry);
                            this.lockedPaths.push(pathEntry);
                            this.autoAlign(pathEntry);
                            this.updateStatus(`Path edited (${result.switches.length} switches). ${this.lockedPaths.length} path(s) active.`);
                        }
                    })
                    .catch(() => this.updateStatus('Failed to save edited path.'));
            } else {
                fetch(new URL('/path', location), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                })
                .then(resp => resp.ok ? resp.json() : null)
                .then(data => {
                    if (data && data.id) {
                        pathEntry.id = data.id;
                        this._pushPathToQueues(pathEntry);
                        this.lockedPaths.push(pathEntry);
                        this._resetSelection();
                        this._rerenderDiff(oldSegs, oldSwitches);
                        this._rerenderChanged();
                        this.autoAlign(pathEntry);
                        this.updateStatus(`Path locked (${result.switches.length} switches). ${this.lockedPaths.length} path(s) active. Right-click to add another.`);
                    }
                })
                .catch(() => this.updateStatus('Failed to create path. Check permissions.'));
            }
        }
    },

    _pushPathToQueues(pathEntry) {
        if (!pathEntry.switches || !pathEntry.id) return;
        const graph = SwitchboardMapper.switchboardGraph;
        if (!graph) return;
        for (const swId of pathEntry.switches) {
            const entry = graph.get(swId);
            if (!entry) continue;
            if (!entry._pathQueue) entry._pathQueue = [];
            if (!entry._pathQueue.includes(pathEntry.id)) {
                const wasEmpty = entry._pathQueue.length === 0;
                entry._pathQueue.push(pathEntry.id);
                if (wasEmpty) {
                    this._applyPathToSwitch(swId, pathEntry);
                }
            }
        }
    },

    _removePathFromQueues(pathId) {
        if (!pathId) return;
        const graph = SwitchboardMapper.switchboardGraph;
        if (!graph) return;
        for (const [swId, entry] of graph) {
            if (!entry._pathQueue) continue;
            const idx = entry._pathQueue.indexOf(pathId);
            if (idx === -1) continue;
            const wasActive = idx === 0;
            entry._pathQueue.splice(idx, 1);
            if (wasActive) {
                if (entry._pathQueue.length > 0) {
                    const nextPathId = entry._pathQueue[0];
                    const nextPath = this.lockedPaths.find(p => p.id === nextPathId);
                    if (nextPath) {
                        this._applyPathToSwitch(swId, nextPath);
                    }
                } else {
                    this._revertAllSignalIds(swId);
                }
                this.recentlyAligned.delete(swId);
            }
        }
    },

    _applyPathToSwitch(swId, pathEntry) {
        if (swId === pathEntry.destinationSwitchId) return;

        const conns = pathEntry.connections || [];
        let inConn = null, outConn = null;
        for (let ci = 0; ci < conns.length - 1; ci++) {
            if (conns[ci].toSwId === swId && conns[ci + 1].fromSwId === swId) {
                inConn = conns[ci];
                outConn = conns[ci + 1];
                break;
            }
        }

        if (inConn) {
            const inPort = this._entryPortOfConn(inConn.fromSwId, swId, inConn.fromNeighbor);
            const outPort = outConn.fromNeighbor.port;
            const neededBranch = this._neededBranch(inPort, outPort);
            if (neededBranch !== null) {
                const jIdx = SwitchboardMapper.getIngameJunctionIndex(swId);
                if (jIdx !== null) {
                    const ingameData = SwitchboardMapper.ingameGraph?.get(jIdx);
                    if (ingameData && ingameData.currentBranch !== neededBranch) {
                        fetch(new URL(`/junction/${jIdx}/toggle`, location), { method: 'POST' })
                            .then(resp => resp.ok ? resp.text() : null)
                            .then(newBranch => {
                                if (newBranch !== null) {
                                    const ig = SwitchboardMapper.ingameGraph?.get(jIdx);
                                    if (ig) ig.currentBranch = parseInt(newBranch);
                                }
                            });
                    } else if (ingameData) {
                        this.recentlyAligned.set(swId, Date.now());
                    }
                }
            }
        }

        if (inConn || swId === pathEntry.originSwitchId) {
            let port;
            if (inConn) {
                port = this._entryPortOfConn(inConn.fromSwId, swId, inConn.fromNeighbor);
            } else {
                port = 'common';
            }
            const sig = this._getSignalAtPort(swId, port);
            if (sig && sig.Id) {
                postSignalControl(sig.Id, { mode: 'Automatic' });
            }
        }
    },

    _processAllSwitchQueues() {
        const graph = SwitchboardMapper.switchboardGraph;
        if (!graph) return;
        let anyChange = false;

        for (const [swId, entry] of graph) {
            const queue = entry._pathQueue;
            if (!queue || queue.length === 0) continue;

            const valid = queue.filter(pid => this.lockedPaths.some(p => p.id === pid));
            if (valid.length !== queue.length) {
                const wasActiveValid = valid.length > 0;
                if (queue[0] !== valid[0]) {
                    anyChange = true;
                    if (wasActiveValid) {
                        const nextPath = this.lockedPaths.find(p => p.id === valid[0]);
                        if (nextPath) this._applyPathToSwitch(swId, nextPath);
                    } else {
                        this._revertAllSignalIds(swId);
                    }
                }
                entry._pathQueue = valid;
                if (valid.length === 0) continue;
            }

            const activePathId = queue[0];
            const pathEntry = this.lockedPaths.find(p => p.id === activePathId);
            if (!pathEntry) continue;

            const conn = (pathEntry.connections || []).find(c => c.toSwId === swId);
            let entryPort = null;
            if (conn) {
                entryPort = this._entryPortOfConn(conn.fromSwId, swId, conn.fromNeighbor);
            } else if (swId === pathEntry.originSwitchId) {
                entryPort = 'common';
            }
            if (!entryPort) continue;

            const sig = this._getSignalAtPort(swId, entryPort);
            let shouldPop = false;
            if (sig && sig.Id) {
                const existing = signalMarkers.get(sig.Id);
                if (existing) {
                    const currentAspect = existing.aspect;
                    if (!entry._lastAspects) entry._lastAspects = {};
                    const prevAspect = entry._lastAspects[sig.Id];
                    entry._lastAspects[sig.Id] = currentAspect;
                    if (prevAspect && prevAspect !== 'S1' && currentAspect === 'S1') {
                        shouldPop = true;
                    }
                }
            }

            if (!shouldPop && !sig) {
                const occSeg = TrackData.getSegment(swId);
                const occBlock = occSeg ? TrackData.getBlock(occSeg.blockId) : null;
                if (occBlock) {
                    const cur = occBlock.occupancyState === 'occupied';
                    const prev = entry._wasOccupied;
                    entry._wasOccupied = cur;
                    if (prev && !cur) shouldPop = true;
                }
            }

            if (!shouldPop) continue;

            const poppedPathId = activePathId;
            queue.shift();
            entry._lastAspects = {};

            const poppedPath = this.lockedPaths.find(p => p.id === poppedPathId);
            if (poppedPath) {
                const popSwitches = poppedPath.switches || [];
                const popIdx = popSwitches.indexOf(swId);
                if (popIdx >= 0) {
                    for (let pi = 0; pi < popIdx; pi++) {
                        const priorSwId = popSwitches[pi];
                        const priorEntry = SwitchboardMapper.switchboardGraph?.get(priorSwId);
                        if (!priorEntry || !priorEntry._pathQueue) continue;
                        if (priorEntry._pathQueue[0] === poppedPathId) {
                            priorEntry._pathQueue.shift();
                            priorEntry._lastAspects = {};
                            if (priorEntry._pathQueue.length > 0) {
                                const np = this.lockedPaths.find(q => q.id === priorEntry._pathQueue[0]);
                                if (np) this._applyPathToSwitch(priorSwId, np);
                            } else {
                                this._revertAllSignalIds(priorSwId);
                            }
                        }
                    }

                    const nextSwId = popSwitches[popIdx + 1];
                    if (!nextSwId || nextSwId === poppedPath.destinationSwitchId) {
                        this._removePathFromQueues(poppedPath.id);
                        const didx = this.lockedPaths.indexOf(poppedPath);
                        if (didx !== -1) this.lockedPaths.splice(didx, 1);
                        if (poppedPath.id) {
                            fetch(new URL(`/path/${poppedPath.id}`, location), { method: 'DELETE' }).catch(() => {});
                        }
                    } else {
                        poppedPath.switches = popSwitches.slice(popIdx + 1);
                        poppedPath.connections = (poppedPath.connections || []).slice(popIdx + 1);
                        poppedPath.segments = this._rebuildSegments(poppedPath.connections || []);
                        poppedPath.originSwitchId = nextSwId;
                        if (poppedPath.id) {
                            fetch(new URL(`/path/${poppedPath.id}`, location), {
                                method: 'PATCH',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    originSwitchId: nextSwId,
                                    destinationSwitchId: poppedPath.destinationSwitchId,
                                    switches: poppedPath.switches,
                                    connections: poppedPath.connections,
                                    segments: poppedPath.segments,
                                    signalIds: this._pathSignalIds(poppedPath.connections || [])
                                })
                            }).catch(() => {});
                        }
                    }
                }
            }

            if (queue.length > 0) {
                const nextPathId = queue[0];
                const nextPath = this.lockedPaths.find(p => p.id === nextPathId);
                if (nextPath) {
                    this._applyPathToSwitch(swId, nextPath);
                }
            } else {
                this._revertAllSignalIds(swId);
            }
            anyChange = true;
        }

        if (anyChange) {
            this._rerenderChanged();
            this.renderPathList();
        }
    },

    _getSignalAtPort(swId, port) {
        const entry = SwitchboardMapper.switchboardGraph?.get(swId);
        if (!entry || !entry.rawSignals) return null;
        if (port === 'common') return entry.rawSignals.Out;
        if (port === 'left') return entry.rawSignals.LeftIn;
        if (port === 'right') return entry.rawSignals.RightIn;
        return null;
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
            const oldSegs = this._currentSegments();
            const oldSwitches = this._currentSwitches();
            const result = this.computePath(this.originSwitchId, this.destinationSwitchId);
            if (result) {
                this.currentPath = result.switches;
                this.pathSegments = result.segments;
                this._rerenderDiff(oldSegs, oldSwitches);
                this._rerenderChanged();
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
        let allConnections = [];
        let prevEntryPort = null;
        for (let i = 0; i < allWaypoints.length - 1; i++) {
            const result = this._aStar(allWaypoints[i], allWaypoints[i + 1], prevEntryPort);
            if (!result) return null;

            if (i > 0) {
                result.switches.shift();
                result.connections.shift();
            }

            const lastConn = result.connections[result.connections.length - 1];
            if (lastConn) {
                prevEntryPort = this._entryPortOfConn(lastConn.fromSwId, lastConn.toSwId, lastConn.fromNeighbor);
            } else {
                prevEntryPort = null;
            }

            allPathSwitches.push(...result.switches);
            allPathSegments.push(...result.segments);
            allConnections.push(...result.connections);
        }
        const uniqueSwitches = [];
        for (const sw of allPathSwitches) {
            if (uniqueSwitches[uniqueSwitches.length - 1] !== sw) uniqueSwitches.push(sw);
        }
        const uniqueSegments = [];
        for (const seg of allPathSegments) {
            if (!uniqueSegments.includes(seg)) uniqueSegments.push(seg);
        }
        return { switches: uniqueSwitches, segments: uniqueSegments, connections: allConnections };
    },

    _pathSignalIds(connections) {
        const ids = [];
        const graph = SwitchboardMapper.switchboardGraph;
        for (const conn of connections) {
            const swId = conn.toSwId;
            const entryPort = this._entryPortOfConn(conn.fromSwId, swId, conn.fromNeighbor);
            if (!entryPort) continue;
            const entry = graph.get(swId);
            if (!entry || !entry.rawSignals) continue;
            let sig = null;
            if (entryPort === 'common') sig = entry.rawSignals.Out;
            else if (entryPort === 'left') sig = entry.rawSignals.LeftIn;
            else if (entryPort === 'right') sig = entry.rawSignals.RightIn;
            if (sig && sig.Id) ids.push(sig.Id);
        }
        return ids;
    },

    _allSignalIds(swId) {
        const entry = SwitchboardMapper.switchboardGraph?.get(swId);
        if (!entry || !entry.rawSignals) return [];
        const ids = [];
        if (entry.rawSignals.Out && entry.rawSignals.Out.Id) ids.push(entry.rawSignals.Out.Id);
        if (entry.rawSignals.LeftIn && entry.rawSignals.LeftIn.Id) ids.push(entry.rawSignals.LeftIn.Id);
        if (entry.rawSignals.RightIn && entry.rawSignals.RightIn.Id) ids.push(entry.rawSignals.RightIn.Id);
        return ids;
    },

    _revertAllSignalIds(swId) {
        const ids = this._allSignalIds(swId);
        for (const sigId of ids) {
            postSignalControl(sigId, { mode: 'Manual' }).then(ok => {
                if (ok) postSignalControl(sigId, { aspect: 'S1' });
            });
        }
    },

    _rebuildSegments(connections) {
        const allSegments = [];
        for (const conn of connections) {
            const segs = this._traceSegments(conn.fromNeighbor.fromNodeId, conn.fromNeighbor.viaNodeId);
            if (segs) allSegments.push(...segs);
        }
        const unique = [];
        for (const seg of allSegments) {
            if (!unique.includes(seg)) unique.push(seg);
        }
        return unique;
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

    _edgeCostNeighbor(swId, neighbor) {
        const segs = this._traceSegments(neighbor.fromNodeId, neighbor.viaNodeId);
        if (!segs) return 1;
        for (const segId of segs) {
            const block = TrackData.getBlockForSegment(segId);
            if (block && block.occupancyState === 'occupied') return 1000;
        }
        return 1;
    },

    _traceFullPathConns(connections) {
        const allSegments = [];
        for (const conn of connections) {
            const segs = this._traceSegments(conn.fromNeighbor.fromNodeId, conn.fromNeighbor.viaNodeId);
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

    _entryPortOfConn(fromSwId, neighborSwId, fromNeighbor) {
        const entry = SwitchboardMapper.switchboardGraph.get(neighborSwId);
        if (!entry) return null;
        const backLink = entry.neighbors.find(n =>
            n.switchId === fromSwId &&
            n.fromNodeId === fromNeighbor.viaNodeId
        );
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
        const cameFromNeighbor = new Map();
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
                const connections = [];
                let node = current;
                let nbr = cameFromNeighbor.get(current);
                while (node) {
                    pathSwitches.unshift(node);
                    const prev = cameFrom.get(node);
                    if (prev !== undefined && nbr) {
                        connections.unshift({
                            fromSwId: prev,
                            toSwId: node,
                            fromNeighbor: nbr
                        });
                    }
                    node = prev;
                    if (node !== undefined) nbr = cameFromNeighbor.get(node);
                }
                const pathSegments = pathSwitches.length > 1 ? this._traceFullPathConns(connections) : [];
                return { switches: pathSwitches, segments: pathSegments, connections };
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

                const cost = this._edgeCostNeighbor(current, nbr);
                const tentativeG = (gScore.get(current) ?? Infinity) + cost;
                if (tentativeG < (gScore.get(nbrId) ?? Infinity)) {
                    cameFrom.set(nbrId, current);
                    cameFromNeighbor.set(nbrId, nbr);
                    entryPorts.set(nbrId, this._entryPortOfConn(current, nbrId, nbr));
                    gScore.set(nbrId, tentativeG);
                    const nbrC = this._getCentroid(nbrId);
                    if (nbrC) fScore.set(nbrId, tentativeG + _h(nbrC, toC));
                    openSet.add(nbrId);
                }
            }
        }
        return null;
    },

    autoAlign(pathEntry) {
        const toToggle = [];
        const conns = pathEntry.connections || [];
        for (let ci = 0; ci < conns.length - 1; ci++) {
            const inConn = conns[ci];
            const outConn = conns[ci + 1];
            const swId = inConn.toSwId;
            if (swId !== outConn.fromSwId) continue;
            if (swId === pathEntry.originSwitchId || swId === pathEntry.destinationSwitchId) continue;

            const entry = SwitchboardMapper.switchboardGraph?.get(swId);
            const queue = entry?._pathQueue;
            if (queue && queue.length > 0 && queue[0] !== pathEntry.id) {
                this.recentlyAligned.set(swId, Date.now());
                continue;
            }

            const jIdx = SwitchboardMapper.getIngameJunctionIndex(swId);
            if (jIdx === null) continue;
            const ingameData = SwitchboardMapper.ingameGraph?.get(jIdx);
            if (!ingameData) continue;

            const inPort = this._entryPortOfConn(inConn.fromSwId, swId, inConn.fromNeighbor);
            const outPort = outConn.fromNeighbor.port;

            const neededBranch = this._neededBranch(inPort, outPort);
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
            this._rerenderChanged();
        });

        this._rerenderChanged();
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
        const pathEntry = this.lockedPaths.find(p => p.switches && p.switches.includes(swId));
        if (!pathEntry) return;

        const conns = pathEntry.connections || [];
        let inConn = null, outConn = null;
        for (let ci = 0; ci < conns.length - 1; ci++) {
            if (conns[ci].toSwId === swId && conns[ci + 1].fromSwId === swId) {
                inConn = conns[ci];
                outConn = conns[ci + 1];
                break;
            }
        }
        if (!inConn || !outConn) return;

        const inPort = this._entryPortOfConn(inConn.fromSwId, swId, inConn.fromNeighbor);
        const outPort = outConn.fromNeighbor.port;
        const neededBranch = this._neededBranch(inPort, outPort);
        if (neededBranch === null) return;
        if (newBranch === neededBranch) {
            this.recentlyAligned.set(swId, Date.now());
            this._rerenderChanged();
        }
    },

    _switchInPaths(swId) {
        for (const p of this.lockedPaths) {
            if (p.switches && p.switches.includes(swId)) return p;
        }
        return null;
    },

    _pathIndex(pathEntry) {
        return this.lockedPaths.indexOf(pathEntry);
    },

    deletePath(pathEntry) {
        const idx = this._pathIndex(pathEntry);
        if (idx === -1) return;

        this._removePathFromQueues(pathEntry.id);

        if (!pathEntry.id) {
            for (const swId of pathEntry.switches) {
                this.recentlyAligned.delete(swId);
            }
            this.lockedPaths.splice(idx, 1);
            this._resetSelection();
            this.editingPathIndex = null;
            this.rerender();
            this.updateStatus(`Path deleted. ${this.lockedPaths.length} path(s) active.`);
            return;
        }
        fetch(new URL(`/path/${pathEntry.id}`, location), { method: 'DELETE' })
            .then(resp => {
                if (resp.ok) {
                    for (const swId of pathEntry.switches) {
                        this.recentlyAligned.delete(swId);
                    }
                    this.lockedPaths.splice(idx, 1);
                    this._resetSelection();
                    this.editingPathIndex = null;
                    this.rerender();
                    this.updateStatus(`Path deleted. ${this.lockedPaths.length} path(s) active.`);
                } else if (resp.status === 403) {
                    this.updateStatus('Permission denied: junction & signal control required.');
                }
            });
    },

    startEdit(pathEntry) {
        const idx = this._pathIndex(pathEntry);
        if (idx === -1) return;
        const oldSegs = this._currentSegments();
        const oldSwitches = this._currentSwitches();

        this._editOldPathId = pathEntry.id || null;
        this._editBackup = {
            pathEntry: {
                ...pathEntry,
                switches: [...pathEntry.switches],
                segments: [...pathEntry.segments],
                connections: pathEntry.connections ? pathEntry.connections.map(c => ({ ...c, fromNeighbor: { ...c.fromNeighbor } })) : []
            },
            index: idx
        };
        this.lockedPaths.splice(idx, 1);
        this.editingPathIndex = idx;

        this._resetSelection();
        this.state = 'selectingOrigin';
        this.originSwitchId = pathEntry.originSwitchId;

        this._rerenderDiff(oldSegs, oldSwitches);
        this._rerenderChanged();
        this.updateStatus('Editing path. Hover a switch to preview, click to lock. Right-click void to cancel.');
    },

    cancelEdit() {
        if (this.editingPathIndex === null) return;
        if (this._editBackup) {
            this.lockedPaths.splice(this._editBackup.index, 0, this._editBackup.pathEntry);
            this._editBackup = null;
        }
        this._editOldPathId = null;
        this._resetSelection();
        this.editingPathIndex = null;
        this.rerender();
        this.updateStatus('Edit cancelled.');
    },

    _isEndpoint(swId, pathEntry) {
        return swId === pathEntry.originSwitchId || swId === pathEntry.destinationSwitchId;
    },

    getOverridesForSegment(segId) {
        const seg = TrackData.getSegment(segId);
        const isSwitch = seg && seg.type === 'switch';
        if (this.lockedPaths.length > 0) {
            for (const p of this.lockedPaths) {
                const inPath = isSwitch ? (p.switches && p.switches.includes(segId)) : (p.segments && p.segments.includes(segId));
                if (inPath) {
                    const block = TrackData.getBlockForSegment(segId);
                    if (block && block.occupancyState === 'occupied') return { color: this.MODE_RED };
                    return { color: this.MODE_GREEN };
                }
            }
        }
        if (this.state !== 'idle') {
            const inSelection = isSwitch ? this.currentPath.includes(segId) : this.pathSegments.includes(segId);
            if (inSelection) {
                const block = TrackData.getBlockForSegment(segId);
                if (block && block.occupancyState === 'occupied') return { color: this.MODE_RED };
                return { color: this.MODE_YELLOW };
            }
        }
        return null;
    },

    getSwitchRimColor(swId) {
        if (this.state === 'selectingOrigin' && swId === this.originSwitchId) return this.MODE_YELLOW;
        if (this.state === 'preview' && this.currentPath.includes(swId) && swId !== this.originSwitchId) return this.MODE_YELLOW;
        if (this.lockedPaths.length > 0) {
            const pathEntry = this._switchInPaths(swId);
            if (pathEntry && !this._isEndpoint(swId, pathEntry)) {
                const entry = SwitchboardMapper.switchboardGraph?.get(swId);
                const queue = entry?._pathQueue;
                if (queue && queue[0] !== pathEntry.id) {
                    return '#886600';
                }
                if (this.recentlyAligned.has(swId)) return this.MODE_GREEN;
                const status = this._alignmentStatus(swId, pathEntry);
                if (status === 'aligned') return this.MODE_GREEN;
                if (status === 'misaligned') return this.MODE_RED;
            }
            if (pathEntry && swId === pathEntry.originSwitchId) return this.MODE_BLUE;
            if (pathEntry && swId === pathEntry.destinationSwitchId) return this.MODE_YELLOW;
        }
        return null;
    },

    _alignmentStatus(swId, pathEntry) {
        const jIdx = SwitchboardMapper.getIngameJunctionIndex(swId);
        if (jIdx === null) return null;
        const ingameData = SwitchboardMapper.ingameGraph?.get(jIdx);
        if (!ingameData) return null;

        const conns = pathEntry.connections || [];
        let inConn = null, outConn = null;
        for (let ci = 0; ci < conns.length - 1; ci++) {
            if (conns[ci].toSwId === swId && conns[ci + 1].fromSwId === swId) {
                inConn = conns[ci];
                outConn = conns[ci + 1];
                break;
            }
        }
        if (!inConn || !outConn) return null;

        const inPort = this._entryPortOfConn(inConn.fromSwId, swId, inConn.fromNeighbor);
        const outPort = outConn.fromNeighbor.port;
        const needed = this._neededBranch(inPort, outPort);
        if (needed === null) return null;
        return ingameData.currentBranch === needed ? 'aligned' : 'misaligned';
    },

    clearWaypoints() {
        for (const m of this.waypointMarkers.values()) {
            switchboardRenderer.map.removeLayer(m);
        }
        this.waypointMarkers.clear();
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

    _rerenderDiff(newSegments, newSwitches) {
        if (typeof switchboardRenderer === 'undefined' || !switchboardRenderer) return;
        const segsToRender = new Set([...this._lastSegments, ...newSegments]);
        const switchesToRender = new Set([...this._lastSwitches, ...newSwitches]);
        for (const segId of segsToRender) {
            const seg = TrackData.getSegment(segId);
            if (seg && seg.type !== 'switch') switchboardRenderer.renderSegment(seg);
        }
        for (const swId of switchesToRender) {
            const seg = TrackData.getSegment(swId);
            if (seg && seg.type === 'switch') switchboardRenderer.renderSegment(seg);
        }
        this._lastSegments = new Set(newSegments);
        this._lastSwitches = new Set(newSwitches);
    },

    _currentSegments() {
        const segs = new Set(this.pathSegments);
        for (const p of this.lockedPaths) if (p.segments) for (const s of p.segments) segs.add(s);
        return segs;
    },

    _currentSwitches() {
        const sws = new Set(this.currentPath);
        for (const p of this.lockedPaths) if (p.switches) for (const s of p.switches) sws.add(s);
        if (this.originSwitchId) sws.add(this.originSwitchId);
        if (this.destinationSwitchId) sws.add(this.destinationSwitchId);
        return sws;
    },

    _rerenderChanged() {
        this._rerenderDiff(this._currentSegments(), this._currentSwitches());
    },

    rerender(segments, switches) {
        if (typeof switchboardRenderer === 'undefined' || !switchboardRenderer) return;
        if (segments || switches) {
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
        } else {
            switchboardRenderer.rerenderAllSegments();
            switchboardRenderer.rerenderSwitches();
        }
    },

    updateStatus(msg) {
        try {
            const el = document.getElementById('pathingStatus');
            if (!el) return;
            if (this.enabled) {
                el.textContent = msg ? `Pathing: enabled — ${msg}` : 'Pathing: enabled';
            } else {
                el.textContent = 'Pathing: disabled';
            }
            this.renderPathList();
        } catch (e) {
            console.warn('[Pathing] updateStatus error:', e);
        }
    },

    _waitingPaths() {
        const waiting = new Set();
        const graph = SwitchboardMapper.switchboardGraph;
        if (!graph) return waiting;
        for (const p of this.lockedPaths) {
            if (!p.switches || p.switches.length === 0) continue;
            let isWaiting = false;
            for (const swId of p.switches) {
                const entry = graph.get(swId);
                const queue = entry?._pathQueue;
                if (queue && queue.length > 1 && queue[0] !== p.id && queue.includes(p.id)) {
                    isWaiting = true;
                    break;
                }
            }
            if (isWaiting) waiting.add(p);
        }
        return waiting;
    },

    renderPathList() {
        try {
            const el = document.getElementById('pathList');
            if (!el) return;
            if (!this.enabled || this.lockedPaths.length === 0) {
                el.innerHTML = '';
                return;
            }
            const waiting = this._waitingPaths();
            const items = this.lockedPaths.map((p) => {
                const label = `${p.originSwitchId || '?'} \u2192 ${p.destinationSwitchId || '?'}`;
                const count = p.switches ? p.switches.length : 0;
                const w = waiting.has(p);
                return `<div style="display:flex;align-items:center;gap:6px;margin:4px 0;${w ? 'opacity:0.5' : ''}">
                    <span style="color:${w ? '#888' : '#4c4'};font-size:16px">${w ? '\u23F3' : '\u2713'}</span>
                    <span style="font-size:14px">${label}</span>
                    <span style="color:#666;font-size:12px;margin-left:auto">${count}</span>
                </div>`;
            }).join('');
            el.innerHTML = `<div style="font-size:13px;color:#aaa;margin-bottom:4px;border-bottom:1px solid #444;padding-bottom:3px;font-weight:600">Active Paths (${this.lockedPaths.length})</div>${items}`;
        } catch (e) {
            console.warn('[Pathing] renderPathList error:', e);
        }
    },
};
