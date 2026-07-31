const TrackRenderer = {
    map: null,
    nodeMarkers: new Map(),
    segmentLayers: new Map(),
    switchBounds: new Map(),
    showSignalAspects: true,
    blockColors: ['#4CAF50', '#2196F3', '#FF9800', '#E91E63', '#9C27B0', '#00BCD4'],
    colorIndex: 0,

    init(map) {
        this.map = map;
    },

    coordsToLatLng(x, y) {
        return L.latLng(y, x);
    },

    latLngToCoords(latlng) {
        return {
            x: Math.round(latlng.lng),
            y: Math.round(latlng.lat)
        };
    },

    getNextColor() {
        const color = this.blockColors[this.colorIndex % this.blockColors.length];
        this.colorIndex++;
        return color;
    },

    getColorForSegmentCount(count) {
        const colors = [
            '#4CAF50',  // 1 - green
            '#2196F3',  // 2 - blue
            '#FF9800',  // 3 - orange
            '#E91E63',  // 4 - pink
            '#9C27B0',  // 5 - purple
            '#00BCD4'   // 6+ - cyan
        ];
        if (count >= 6) return colors[5];
        return colors[count - 1];
    },

    assignBlockColors() {
        for (const block of TrackData.blocks.values()) {
            const count = block.segmentIds ? block.segmentIds.length : 0;
            block.color = this.getColorForSegmentCount(count);
        }
        this.rerenderAllSegments();
    },

    rerenderAllSegments() {
        const _t0 = performance.now();
        for (const seg of TrackData.segments.values()) {
            this.renderSegment(seg);
        }
        const _elapsed = performance.now() - _t0;
        if (_elapsed > 100) console.warn(`[PERF] rerenderAllSegments took ${_elapsed.toFixed(0)}ms`);
    },

    rerenderBlocks(blockIds) {
        const _t0 = performance.now();
        for (const seg of TrackData.segments.values()) {
            const block = TrackData.getBlockForSegment(seg.id);
            if (block && blockIds.has(block.id)) {
                this.renderSegment(seg);
            }
        }
        const _elapsed = performance.now() - _t0;
        if (_elapsed > 100) console.warn(`[PERF] rerenderBlocks(${blockIds.size}) took ${_elapsed.toFixed(0)}ms`);
    },

    rerenderSwitches() {
        for (const seg of TrackData.segments.values()) {
            if (seg.type === 'switch') {
                this.renderSegment(seg);
            }
        }
    },

    renderNode(node, isSelected = false, forceVisible = false) {
        if (this.nodeMarkers.has(node.id)) {
            this.clearNode(node.id);
        }

        const pos = this.coordsToLatLng(node.x, node.y);
        const color = isSelected ? '#FF5722' : '#888';
        
        const marker = L.circle(pos, {
            radius: 0.2,
            fillColor: color,
            fillOpacity: 1,
            color: '#fff',
            weight: 10
        });

        marker.nodeId = node.id;
        this.nodeMarkers.set(node.id, marker);
        
        if (isSelected || forceVisible) {
            marker.addTo(this.map);
        }
        
        return marker;
    },

    renderJunctionNodes() {
        const junctions = TrackData.getJunctionNodes();
        for (const node of junctions) {
            const pos = this.coordsToLatLng(node.x, node.y);
            const marker = L.circle(pos, {
                radius: 0.25,
                fillColor: '#00BFFF',
                fillOpacity: 1,
                color: '#fff',
                weight: 10
            });
            marker.nodeId = node.id;
            marker.junctionMarker = true;
            this.nodeMarkers.set(node.id + '_junction', marker);
            marker.addTo(this.map);
        }
    },

    clearJunctionMarkers() {
        for (const [key, marker] of this.nodeMarkers) {
            if (marker.junctionMarker) {
                this.map.removeLayer(marker);
                this.nodeMarkers.delete(key);
            }
        }
    },

    clearNode(nodeId) {
        const marker = this.nodeMarkers.get(nodeId);
        if (marker) {
            this.map.removeLayer(marker);
            this.nodeMarkers.delete(nodeId);
        }
    },

    renderSegment(segment) {
        if (this.segmentLayers.has(segment.id)) {
            this.clearSegment(segment.id);
        }

        const block = TrackData.getBlockForSegment(segment.id);
        let color;
        if (!block) {
            color = '#666';
        } else if (block.occupancyState === 'occupied') {
            color = '#a02020';
        } else if (block.occupancyState === 'clear') {
            if (typeof PathingController !== 'undefined' && PathingController.showGrayClear) {
                color = '#888';
            } else {
                color = '#208020';
            }
        } else {
            color = '#888';
        }

        if (typeof PathingController !== 'undefined' && (PathingController.state !== 'idle' || PathingController.lockedPaths.length > 0)) {
            const pathOverride = PathingController.getOverridesForSegment(segment.id);
            if (pathOverride) color = pathOverride.color;
        }

        let layer;
        
        if (segment.type === 'switch') {
            layer = this.renderSwitch(segment, color);
        } else {
            layer = this.renderTrackSegment(segment, color);
        }

        if (layer) {
            layer.segmentId = segment.id;
            this.segmentLayers.set(segment.id, layer);
        }

        return layer;
    },

    renderTrackSegment(segment, color) {
        const fromNode = TrackData.getNode(segment.n1);
        const toNode = TrackData.getNode(segment.n2);
        
        if (!fromNode || !toNode) return null;

        const from = this.coordsToLatLng(fromNode.x, fromNode.y);
        const to = this.coordsToLatLng(toNode.x, toNode.y);

        const polyline = L.polyline([from, to], {
            color: color,
            weight: 4,
            opacity: 0.9
        });

        polyline.addTo(this.map);

        polyline.on('click', () => {
            if (typeof PathingController !== 'undefined' && PathingController.enabled) {
                PathingController.onSegmentClick(segment.id);
            }
        });

        polyline.on('mouseover', () => {
            if (typeof PathingController !== 'undefined' && PathingController.enabled) {
                PathingController.onSegmentHover(segment.id);
            }
        });

        polyline.on('mouseout', () => {
            if (typeof PathingController !== 'undefined' && PathingController.enabled) {
                PathingController.onSegmentHoverEnd();
            }
        });

        return polyline;
    },

    renderSwitch(segment, color) {
        const inbound = TrackData.getNode(segment.merging);
        const out1 = TrackData.getNode(segment.nl);
        const out2 = TrackData.getNode(segment.nr);

        if (!inbound || !out1 || !out2) {
            return null;
        }

        const inboundPos = this.coordsToLatLng(inbound.x, inbound.y);
        const out1Pos = this.coordsToLatLng(out1.x, out1.y);
        const out2Pos = this.coordsToLatLng(out2.x, out2.y);

        const group = L.featureGroup();

        const allX = [inbound.x, out1.x, out2.x];
        const allY = [inbound.y, out1.y, out2.y];
        const minX = Math.min(...allX);
        const maxX = Math.max(...allX);
        const minY = Math.min(...allY);
        const maxY = Math.max(...allY);

        const rectBounds = L.latLngBounds([
            this.coordsToLatLng(minX, minY),
            this.coordsToLatLng(maxX, maxY)
        ]);

        const jIdx = SwitchboardMapper.getIngameJunctionIndex(segment.id);
        const ingameData = jIdx !== null ? SwitchboardMapper.ingameGraph?.get(jIdx) : null;
        const currentBranch = ingameData?.currentBranch;

        let rimColor = color;
        if (typeof PathingController !== 'undefined' && (PathingController.state !== 'idle' || PathingController.lockedPaths.length > 0)) {
            const pcRim = PathingController.getSwitchRimColor(segment.id);
            if (pcRim) rimColor = pcRim;
        } else if (typeof SwitchboardSignals !== 'undefined' && SwitchboardSignals.initialized && typeof SwitchboardOccupancy !== 'undefined' && SwitchboardOccupancy.mode === 'hardcore') {
            const aspectState = SwitchboardSignals.getSwitchAspectForBlock(segment.id);
            if (aspectState === 'clear') rimColor = '#208020';
            else if (aspectState === 'occupied') rimColor = '#a02020';
        }

        const rect = L.rectangle(rectBounds, {
            color: rimColor,
            weight: 2,
            fillColor: '#102020',
            fillOpacity: 0.7
        });
        rect.addTo(group);

        this.switchBounds.set(segment.id, { minX, maxX, minY, maxY });

        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        const isHorizontal = (maxX - minX) >= (maxY - minY);

        const graphEntry = SwitchboardMapper.switchboardGraph?.get(segment.id);
        const rawSigs = graphEntry?.rawSignals;
        if (this.showSignalAspects && rawSigs) {
            const portSignalMap = [
                { node: inbound, signal: rawSigs.Out },
                { node: out1, signal: rawSigs.LeftIn },
                { node: out2, signal: rawSigs.RightIn }
            ];
            for (const { node, signal } of portSignalMap) {
                if (!signal) continue;
                const aspect = signal.aspect;
                if (aspect === null || aspect === undefined) continue;

                let dotColor = '#666';
                if (SwitchboardSignals.STOP_ASPECTS.has(aspect)) dotColor = '#ff4444';
                else if (SwitchboardSignals.CAUTION_ASPECTS.has(aspect)) dotColor = '#eecc33';
                else if (SwitchboardSignals.CLEAR_ASPECTS.has(aspect)) dotColor = '#44ff44';

                let dotX, dotY;
                if (isHorizontal) {
                    const fwdDir = cx >= node.x ? 1 : -1;
                    const sideDir = node.y >= cy ? 1 : -1;
                    dotX = node.x + fwdDir * 0.5;
                    dotY = node.y + sideDir * 0.25;

                    L.polyline([
                        this.coordsToLatLng(node.x, node.y + sideDir * 0.25),
                        this.coordsToLatLng(dotX, dotY)
                    ], { color: '#000', weight: 10 }).addTo(group);
                } else {
                    const fwdDir = cy >= node.y ? 1 : -1;
                    const sideDir = node.x >= cx ? 1 : -1;
                    dotX = node.x + sideDir * 0.25;
                    dotY = node.y + fwdDir * 0.5;

                    L.polyline([
                        this.coordsToLatLng(node.x + sideDir * 0.25, node.y),
                        this.coordsToLatLng(dotX, dotY)
                    ], { color: '#000', weight: 10 }).addTo(group);
                }

                L.circle(this.coordsToLatLng(dotX, dotY), {
                    radius: 0.15,
                    fillColor: dotColor,
                    fillOpacity: 1,
                    color: '#000',
                    weight: 1
                }).addTo(group);
            }
        }

        const activeColor = color;
        const inactiveColor = '#444';

        let out1Color, out2Color;
        if (currentBranch === 0) {
            out1Color = activeColor;
            out2Color = inactiveColor;
        } else if (currentBranch === 1) {
            out1Color = inactiveColor;
            out2Color = activeColor;
        } else {
            out1Color = inactiveColor;
            out2Color = inactiveColor;
        }

        const out1Active = currentBranch === 0;
        const out2Active = currentBranch === 1;

        const out1Polyline = L.polyline([inboundPos, out1Pos], {
            color: out1Color,
            weight: 5,
            opacity: 1
        });

        const out2Polyline = L.polyline([inboundPos, out2Pos], {
            color: out2Color,
            weight: 5,
            opacity: 1
        });

        if (out1Active) {
            out2Polyline.addTo(group);
            out1Polyline.addTo(group);
        } else {
            out1Polyline.addTo(group);
            out2Polyline.addTo(group);
        }

        group.addTo(this.map);

        group.on('click', () => {
            if (jIdx !== null) {
                fetch(new URL(`/junction/${jIdx}/toggle`, location), { method: 'POST' })
                    .then(resp => resp.ok ? resp.text() : Promise.reject(new Error(`${resp.status}`)))
                    .then(newBranch => console.log(`%c[${segment.id}] toggled -> branch ${newBranch} (block: ${segment.blockId})`, 'color: #00ff00'))
                    .catch(err => console.error(`%c[${segment.id}] toggle failed: ${err.message}`, 'color: #ff0000'));
            } else {
                console.log(`%c[${segment.id}] -> NO MAPPING (unmapped switch)`, 'color: #ff0000');
            }
        });

        group.on('mouseover', () => {
        });

        group.on('mouseout', () => {
        });

        return group;
    },

    clearSegment(segmentId) {
        const layer = this.segmentLayers.get(segmentId);
        if (layer) {
            this.map.removeLayer(layer);
            this.segmentLayers.delete(segmentId);
        }
        this.switchBounds.delete(segmentId);
    },

    highlightSegment(segmentId, highlight = true) {
        const layer = this.segmentLayers.get(segmentId);
        if (layer) {
            const color = highlight ? '#FF5722' : '#666';
            if (layer.setStyle) {
                layer.setStyle({ color: color });
            } else {
                layer.eachLayer(l => {
                    if (l.setStyle) l.setStyle({ color: color });
                });
            }
        }
    },

    renderAll() {
        this.clearAll();

        for (const segment of TrackData.segments.values()) {
            this.renderSegment(segment);
        }

        for (const node of TrackData.nodes.values()) {
            this.renderNode(node);
        }
    },

    updateSwitchStates(states) {
        if (!SwitchboardMapper.ingameGraph || !SwitchboardMapper.mapping) return;
        const changed = [];
        for (const seg of TrackData.segments.values()) {
            if (seg.type !== 'switch') continue;
            const jIdx = SwitchboardMapper.getIngameJunctionIndex(seg.id);
            if (jIdx === null || jIdx >= states.length) continue;
            const ingameData = SwitchboardMapper.ingameGraph.get(jIdx);
            if (!ingameData) continue;
            if (ingameData.currentBranch !== states[jIdx]) {
                ingameData.currentBranch = states[jIdx];
                changed.push(seg);
            }
        }
        for (const seg of changed) {
            this.renderSegment(seg);
        }
        if (changed.length > 0 && typeof SwitchboardSignals !== 'undefined' && SwitchboardSignals.initialized) {
            SwitchboardSignals.updateAllVirtualSignals();
        }
    },

    setSegmentColor(segment, color) {
        if (!segment) return;
        if (segment.type === 'switch') {
            this.renderSegment(segment);
            return;
        }
        const layer = this.segmentLayers.get(segment.id);
        if (!layer) {
            this.renderSegment(segment);
            return;
        }
        layer.setStyle({ color: color });
    },

    clearAll() {
        for (const marker of this.nodeMarkers.values()) {
            this.map.removeLayer(marker);
        }
        this.nodeMarkers.clear();

        for (const layer of this.segmentLayers.values()) {
            this.map.removeLayer(layer);
        }
        this.segmentLayers.clear();
    },

    updateNode(nodeId, isSelected = false) {
        const node = TrackData.getNode(nodeId);
        if (node) {
            this.renderNode(node, isSelected);
        }
    },

    updateSegment(segmentId) {
        const segment = TrackData.getSegment(segmentId);
        if (segment) {
            this.renderSegment(segment);
        }
    },

    getSegmentAtPoint(latlng, tolerance = 0) {
        const coords = this.latLngToCoords(latlng);
        
        const node = TrackData.getNodeAt(coords.x, coords.y);
        if (node) return null;
        
        for (const [segId, layer] of this.segmentLayers) {
            const segment = TrackData.getSegment(segId);
            if (!segment) continue;

            if (segment.type === 'switch') {
                const bounds = this.switchBounds.get(segId);
                if (bounds && coords.x >= bounds.minX && coords.x <= bounds.maxX && 
                    coords.y >= bounds.minY && coords.y <= bounds.maxY) {
                    return segment;
                }
                if (this.pointNearLine(coords, segment.merging, segment.nl, 0) ||
                    this.pointNearLine(coords, segment.merging, segment.nr, 0)) {
                    return segment;
                }
            } else {
                if (this.pointNearLine(coords, segment.n1, segment.n2, 0)) {
                    return segment;
                }
            }
        }
        return null;
    },

    pointNearLine(point, node1Id, node2Id, tolerance) {
        const node1 = TrackData.getNode(node1Id);
        const node2 = TrackData.getNode(node2Id);
        if (!node1 || !node2) return false;

        const dist = this.pointToSegmentDistance(point, node1, node2);
        return dist <= tolerance;
    },

    pointToSegmentDistance(point, node1, node2) {
        const A = point.x - node1.x;
        const B = point.y - node1.y;
        const C = node2.x - node1.x;
        const D = node2.y - node1.y;

        const dot = A * C + B * D;
        const lenSq = C * C + D * D;
        let param = -1;
        
        if (lenSq !== 0) param = dot / lenSq;

        let xx, yy;
        if (param < 0) {
            xx = node1.x;
            yy = node1.y;
        } else if (param > 1) {
            xx = node2.x;
            yy = node2.y;
        } else {
            xx = node1.x + param * C;
            yy = node1.y + param * D;
        }

        const dx = point.x - xx;
        const dy = point.y - yy;
        return Math.sqrt(dx * dx + dy * dy);
    }
};