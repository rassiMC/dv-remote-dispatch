const SwitchboardOccupancy = {
    mode: 'direct',
    trackOccupation: new Map(),

    setMode(mode) {
        if (this.mode === mode) return;
        this.mode = mode;
        console.log(`[SwitchboardOccupancy] mode set to: ${mode}`);

        if (mode === 'direct') {
            this.updateAllBlockOccupancy();
        } else {
            if (typeof SwitchboardSignals !== 'undefined' && SwitchboardSignals.initialized) {
                SwitchboardSignals.updateAllVirtualSignals();
            }
            if (typeof switchboardRenderer !== 'undefined' && switchboardRenderer) {
                switchboardRenderer.rerenderAllSegments();
            }
        }
    },

    updateTrackData(data) {
        this.trackOccupation.clear();
        for (const [trackId, occupied] of Object.entries(data)) {
            this.trackOccupation.set(trackId, occupied === true);
        }
        if (this.mode === 'direct') {
            this.updateAllBlockOccupancy();
        }
    },

    getTrackIdsForBlock(blockId) {
        if (!SwitchboardMapper.ingameGraph || !SwitchboardMapper.mapping) return [];

        const trackIds = new Set();
        const switchMap = getBlockSwitchMap();
        const switchEntries = switchMap.get(blockId);

        if (!switchEntries || switchEntries.length === 0) return [];

        for (const { switchId, port } of switchEntries) {
            const jIdx = SwitchboardMapper.getIngameJunctionIndex(switchId);
            if (jIdx === null) continue;
            const jData = SwitchboardMapper.ingameGraph.get(jIdx);
            if (!jData) continue;

            if (port === 'common') {
                for (const tid of (jData.incomingTracks || [])) {
                    trackIds.add(tid);
                }
            } else if (port === 'left' || port === 'right') {
                const branchIdx = port === 'left' ? 0 : 1;
                if (jData.outgoingTracks && jData.outgoingTracks.length > branchIdx) {
                    trackIds.add(jData.outgoingTracks[branchIdx]);
                }
                for (const tid of (jData.outgoingTracks || [])) {
                    trackIds.add(tid);
                }
            }
        }

        return Array.from(trackIds);
    },

    computeBlockOccupancy(blockId) {
        const trackIds = this.getTrackIdsForBlock(blockId);
        if (trackIds.length === 0) return null;

        let foundOccupied = false;
        let foundAny = false;

        for (const trackId of trackIds) {
            if (this.trackOccupation.has(trackId)) {
                foundAny = true;
                if (this.trackOccupation.get(trackId)) {
                    foundOccupied = true;
                    break;
                }
            }
        }

        if (!foundAny) return null;
        return foundOccupied;
    },

    updateAllBlockOccupancy() {
        if (typeof TrackData === 'undefined' || !TrackData.blocks) return;
        if (typeof switchboardRenderer === 'undefined' || !switchboardRenderer) return;
        if (this.trackOccupation.size === 0) return;

        const changedBlocks = new Set();

        for (const [blockId, block] of TrackData.blocks) {
            const occupied = this.computeBlockOccupancy(blockId);
            const newState = occupied === null ? 'unknown' : (occupied ? 'occupied' : 'clear');
            if (block.occupancyState !== newState) {
                block.occupancyState = newState;
                changedBlocks.add(blockId);
            }
        }

        if (changedBlocks.size > 0) {
            switchboardRenderer.rerenderBlocks(changedBlocks);
            switchboardRenderer.rerenderSwitches();
        }
    },

    get isActive() {
        return this.mode === 'direct';
    }
};
