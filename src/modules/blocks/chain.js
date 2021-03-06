const { transactionSortFunc } = require('src/helpers/transaction.utils');
const { getOrCreateAccount } = require('src/helpers/account.utils');

const async = require('async');
const transactionTypes = require('../../helpers/transactionTypes.js');

const _ = require('lodash');
const Inserts = require('../../helpers/inserts.js');
const sql = require('../../sql/blocks.js');
const utils = require('../../utils');

let modules;
let library;
let self;
const __private = {};

/**
 * Initializes library.
 * @memberof module:blocks
 * @class
 * @classdesc Main Chain logic.
 * Allows set information.
 * @param {Object} logger
 * @param {Block} block
 * @param {Transaction} transaction
 * @param {Database} db
 * @param {Object} genesisblock
 * @param {bus} bus
 * @param {Sequence} balancesSequence
 */
function Chain(logger, block, transaction, db, genesisblock, bus, balancesSequence) {
    library = {
        logger,
        db,
        genesisblock,
        bus,
        balancesSequence,
        logic: {
            block,
            transaction,
        },
    };
    self = this;

    library.logger.trace('Blocks->Chain: Submodule initialized.');
    return self;
}

/**
 * Save genesis block to database
 *
 * @async
 * @param  {Function} cb Callback function
 * @return {Function} cb Callback function from params (through setImmediate)
 * @return {Object}   cb.err Error if occurred
 */
Chain.prototype.saveGenesisBlock = async () => {
    // Check if genesis block ID already exists in the database
    // FIXME: Duplicated, there is another SQL query that we can use for that
    const rows = await library.db.query(sql.getGenesisBlockId, { id: library.genesisblock.block.id });
    const blockId = rows.length && rows[0].id;

    if (!blockId) {
        await self.newApplyGenesisBlock(library.genesisblock.block, false, true);
    }
};

/**
 * Save block with transactions to database
 *
 * @async
 * @param  {Object}   block Full normalized block
 * @param  {Function} cb Callback function
 * @return {Function|afterSave} cb If SQL transaction was OK - returns safterSave execution,
 *                                 if not returns callback function from params (through setImmediate)
 * @return {String}   cb.err Error if occurred
 */
Chain.prototype.saveBlock = function (block, cb) {
    // Prepare and execute SQL transaction
    // WARNING: DB_WRITE
    library.db.tx(async (t) => {
        // Create bytea fields (buffers), and returns pseudo-row object promise-like
        const promise = library.logic.block.dbSave(block);
        // Initialize insert helper
        const inserts = new Inserts(promise, promise.values);

        const promises = [
            // Prepare insert SQL query
            t.none(inserts.template(), promise.values)
        ];

        // Apply transactions inserts
        t = await __private.promiseTransactions(t, block, promises);
        // Exec inserts as batch
        t.batch(promises);
    })
        .then(() =>
            // Execute afterSave for transactions
            __private.afterSave(block, cb))
        .catch((err) => {
            library.logger.error(err.stack);
            return setImmediate(cb, 'Blocks#saveBlock error');
        });
};

Chain.prototype.newSaveBlock = async (block) => {
    try {
        await library.db.tx(async (t) => {
            const promise = library.logic.block.dbSave(block);
            const inserts = new Inserts(promise, promise.values);

            const promises = [t.none(inserts.template(), promise.values)];
            // Exec inserts as batch
            await t.batch(promises);
        });
    } catch (e) {
        library.logger.error(`[Chain][saveBlock][tx]: ${e}`);
        library.logger.error(`[Chain][saveBlock][tx][stack]: \n ${e.stack}`);
    }
};

Chain.prototype.saveTransaction = async (transaction) => {
    try {
        await library.db.tx(async (t) => {
            const promises = await library.logic.transaction.dbSave(transaction);
            const queries = promises.map(promise => {
                const inserts = new Inserts(promise, promise.values);
                return t.none(inserts.template(), promise.values);
            });
            await t.batch(queries);
        });
    } catch (error) {
        library.logger.error(`[Chain][saveTransaction][tx]: ${error}`);
        library.logger.error(`[Chain][saveTransaction][tx][stack]:\n${error.stack}`);
    }
};

/**
 * Execute afterSave callback for transactions depends on transaction type
 *
 * @private
 * @async
 * @method afterSave
 * @param  {Object}   block Full normalized block
 * @param  {Function} cb Callback function
 * @return {Function} cb Callback function from params (through setImmediate)
 * @return {Object}   cb.err Error if occurred
 */
__private.afterSave = function (block, cb) {
    library.bus.message('transactionsSaved', block.transactions);
    // Execute afterSave callbacks for each transaction, depends on tx type
    // see: logic.outTransfer.afterSave, logic.dapp.afterSave
    async.eachSeries(block.transactions,
        (transaction, cbTransaction) => library.logic.transaction.afterSave(transaction, cbTransaction),
        err => setImmediate(cb, err));
};

__private.newAfterSave = async (block) => {
    library.bus.message('transactionsSaved', block.transactions);
    for (const trs of block.transactions) {
        try {
            await library.logic.transaction.afterSave(trs);
        } catch (e) {
            library.logger.error(`[Chain][afterSave]: ${e}`);
            library.logger.error(`[Chain][afterSave][stack]: \n ${e.stack}`);
        }
    }
};

/**
 * Build a sequence of transaction queries
 * // FIXME: Processing here is not clean
 *
 * @private
 * @method promiseTransactions
 * @param  {Object} t SQL connection object
 * @param  {Object} block Full normalized block
 * @param  {Object} blockPromises Not used
 * @return {Object} t SQL connection object filled with inserts
 * @throws Will throw 'Invalid promise' when no promise, promise.values or promise.table
 */
__private.promiseTransactions = async (t, block) => {
    if (_.isEmpty(block.transactions)) {
        return t;
    }

    const transactionIterator = async (transaction) => {
        // Apply block ID to transaction
        transaction.blockId = block.id;
        // Create bytea fileds (buffers), and returns pseudo-row promise-like object
        /* if(block.height === 1){
         transaction.timestamp=slots.getTime();
         } */

        return library.logic.transaction.dbSave(transaction);
    };

    const promiseGrouper = (promise) => {
        if (promise && promise.table) {
            return promise.table;
        }
        throw 'Invalid promise';
    };

    const typeIterator = (type) => {
        let values = [];
        _.each(type, (promise) => {
            if (promise && promise.values) {
                values = values.concat(promise.values);
            } else {
                throw 'Invalid promise';
            }
        });

        // Initialize insert helper
        const inserts = new Inserts(type[0], values, true);
        // Prepare insert SQL query
        t.none(inserts.template(), inserts);
    };

    const promises = [];
    for (const trs of block.transactions) {
        promises.push(...await transactionIterator(trs));
    }
    _.each(_.groupBy(promises, promiseGrouper), typeIterator);

    return t;
};

/**
 * Deletes block from blocks table
 *
 * @private
 * @async
 * @method deleteBlock
 * @param  {number}   blockId ID of block to delete
 * @param  {Function} cb Callback function
 * @return {Function} cb Callback function from params (through setImmediate)
 * @return {Object}   cb.err String if SQL error occurred, null if success
 */
Chain.prototype.deleteBlock = function (blockId, cb) {
    // Delete block with ID from blocks table
    // WARNING: DB_WRITE
    library.db.none(sql.deleteBlock, { id: blockId })
        .then(() => {
            utils.deleteDocumentByQuery({
                index: 'blocks_list',
                type: 'blocks_list',
                body: {
                    query: {
                        term: { id: blockId }
                    }
                }
            }, (err) => {
                if (err) {
                    library.logger.error(`Elasticsearch: document deletion error: ${err}`);
                } else {
                    library.logger.info('Elasticsearch: document deleted successfully');
                }
            });
            return setImmediate(cb);
        })
        .catch((err) => {
            library.logger.error(
                `Error Message : ${err.message}, Error query : ${err.query}, Error stack : ${err.stack}`
            );
            return setImmediate(cb, 'Blocks#deleteBlock error');
        });
};

/**
 * Deletes all blocks with height >= supplied block ID
 *
 * @public
 * @async
 * @method deleteAfterBlock
 * @param  {number}   blockId ID of block to begin with
 * @param  {Function} cb Callback function
 * @return {Function} cb Callback function from params (through setImmediate)
 * @return {Object}   cb.err SQL error
 * @return {Object}   cb.res SQL response
 */
Chain.prototype.deleteAfterBlock = function (blockId, cb) {
    library.db.query(sql.deleteAfterBlock, { id: blockId })
        .then(res => setImmediate(cb, null, res))
        .catch((err) => {
            library.logger.error(err.stack);
            return setImmediate(cb, 'Blocks#deleteAfterBlock error');
        });
};


/**
 * Apply genesis block's transactions to blockchain
 *
 * @private
 * @async
 * @method applyGenesisBlock
 * @param  {Object}   block Full normalized genesis block
 * @param  {Function} cb Callback function
 * @return {Function} cb Callback function from params (through setImmediate)
 * @return {Object}   cb.err Error if occurred
 */
Chain.prototype.applyGenesisBlock = function (block, cb) {
    // Sort transactions included in block
    block.transactions = block.transactions.sort((a) => {
        if (a.type === transactionTypes.VOTE) {
            return 1;
        }
        return 0;
    });
    // Initialize block progress tracker
    const tracker = modules.blocks.utils.getBlockProgressLogger(
        block.transactions.length, block.transactions.length / 100, 'Genesis block loading'
    );
    async.eachSeries(block.transactions, (transaction, cb) => {
        // Apply transactions through setAccountAndGet, bypassing unconfirmed/confirmed states
        // FIXME: Poor performance - every transaction cause SQL query to be executed
        // WARNING: DB_WRITE
        modules.accounts.setAccountAndGet({ publicKey: transaction.senderPublicKey }, (err, sender) => {
            if (err) {
                return setImmediate(cb, {
                    message: err,
                    transaction,
                    block
                });
            }
            // Apply transaction to confirmed & unconfirmed balances
            // WARNING: DB_WRITE
            __private.applyTransaction(block, transaction, sender, cb);
            // Update block progress tracker
            tracker.applyNext();
        });
    }, (err) => {
        if (err) {
            // If genesis block is invalid, kill the node...
            library.logger.error('Genesis block error: ', err.message);
            return process.exit(0);
        }
        // Set genesis block as last block
        modules.blocks.lastBlock.set(block);
        // Tick round
        // WARNING: DB_WRITE
        modules.rounds.tick(block, cb);
    });
};

Chain.prototype.deleteAfterBlock = function (blockId, cb) {
    library.db.query(sql.deleteAfterBlock, { id: blockId })
        .then(res => setImmediate(cb, null, res))
        .catch((err) => {
            library.logger.error(err.stack);
            return setImmediate(cb, 'Blocks#deleteAfterBlock error');
        });
};


/**
 * Apply genesis block's transactions to blockchain
 *
 * @private
 * @async
 * @method applyGenesisBlock
 * @param  {Object}   block Full normalized genesis block
 * @param  {Function} cb Callback function
 * @return {Function} cb Callback function from params (through setImmediate)
 * @return {Object}   cb.err Error if occurred
 */
Chain.prototype.newApplyGenesisBlock = async (block, verify, save) => {
    block.transactions = block.transactions.sort(transactionSortFunc);
    try {
        await modules.blocks.verify.newProcessBlock(block, false, save, verify, false);
        library.logger.info('[Chain][applyGenesisBlock] Genesis block loading');
    } catch (e) {
        library.logger.error(`[Chain][applyGenesisBlock] ${e}`);
        library.logger.error(`[Chain][applyGenesisBlock][stack] ${e.stack}`);
    }


};

/**
 * Apply transaction to unconfirmed and confirmed
 *
 * @private
 * @async
 * @method applyTransaction
 * @param  {Object}   block Block object
 * @param  {Object}   transaction Transaction object
 * @param  {Object}   sender Sender account
 * @param  {Function} cb Callback function
 * @return {Function} cb Callback function from params (through setImmediate)
 * @return {Object}   cb.err Error if occurred
 */
__private.applyTransaction = function (block, transaction, sender, cb) {
    modules.transactions.applyUnconfirmed(transaction, sender, (err) => {
        if (err) {
            return setImmediate(cb, {
                message: err,
                transaction,
                block
            });
        }

        modules.transactions.apply(transaction, block, sender, (applyErr) => {
            if (applyErr) {
                return setImmediate(cb, {
                    message: `Failed to apply transaction: ${transaction.id}`,
                    transaction,
                    block
                });
            }
            return setImmediate(cb);
        });
    });
};

/**
 * Apply verified block
 *
 * @private
 * @async
 * @method applyBlock
 * @emits  SIGTERM
 * @param  {Object}   block Full normalized block
 * @param  {boolean}  broadcast Indicator that block needs to be broadcasted
 * @param  {Function} cb Callback function
 * @param  {boolean}  saveBlock Indicator that block needs to be saved to database
 * @return {Function} cb Callback function from params (through setImmediate)
 * @return {Object}   cb.err Error if occurred
 */
Chain.prototype.applyBlock = function (block, broadcast, cb, saveBlock) {
    // Prevent shutdown during database writes.
    modules.blocks.isActive.set(true);

    // Transactions to rewind in case of error.
    let appliedTransactions = {};

    // List of unconfirmed transactions ids.
    let unconfirmedTransactionIds = new Set();

    async.series({
        // Rewind any unconfirmed transactions before applying block.
        // TODO: It should be possible to remove this call if we can guarantee that only this function is processing transactions atomically. Then speed should be improved further.
        // TODO: Other possibility, when we rebuild from block chain this action should be moved out of the rebuild function.
        undoUnconfirmedList(seriesCb) {
            modules.transactions.undoUnconfirmedList((err, ids) => {
                if (err) {
                    // Fatal error, memory tables will be inconsistent
                    library.logger.error('Failed to undo unconfirmed list', err);

                    return process.exit(0);
                }
                ids.forEach(id => unconfirmedTransactionIds.add(id));
                return setImmediate(seriesCb);
            });
        },
        // Apply transactions to unconfirmed mem_accounts fields.
        applyUnconfirmed(seriesCb) {
            async.eachSeries(block.transactions, (transaction, eachSeriesCb) => {
                async.series({
                    verifyUnconfirmed(series2Cb) {
                        modules.accounts.getAccount({ publicKey: transaction.senderPublicKey }, (err, sender) => {
                            if (err) {
                                return setImmediate(series2Cb, err);
                            }

                            library.logic.transaction.verifyUnconfirmed({
                                trs: transaction,
                                sender,
                                cb: series2Cb,
                            });
                        });
                    },
                    applyUnconfirmed(series2Cb) {
                        // DATABASE write
                        modules.accounts.getAccount({ publicKey: transaction.senderPublicKey }, (err, sender) => {
                            if (err) {
                                return setImmediate(series2Cb, err);
                            }

                            // DATABASE: write
                            modules.transactions.applyUnconfirmed(transaction, sender, (errAply) => {
                                if (errAply) {
                                    errAply = ['Failed to apply transaction:', transaction.id, '-', errAply].join(' ');
                                    library.logger.error(errAply);
                                    library.logger.error('Transaction', transaction);
                                    return setImmediate(series2Cb, errAply);
                                }

                                appliedTransactions[transaction.id] = transaction;

                                // Remove the transaction from the node queue, if it was present.
                                unconfirmedTransactionIds.delete(transaction.id);

                                return setImmediate(series2Cb);
                            });
                        });
                    },
                }, err => setImmediate(eachSeriesCb, err));
            }, (err) => {
                if (err) {
                    library.logger.error(`cannot apply unconfirmed transaction. ${err}.`);
                    // Rewind any already applied unconfirmed transactions.
                    // Leaves the database state as per the previous block.
                    async.eachSeries(block.transactions, (transaction, eachSeriesCb) => {
                        if (!appliedTransactions[transaction.id]) {
                            return setImmediate(eachSeriesCb);
                        }

                        modules.accounts.getAccount({ publicKey: transaction.senderPublicKey }, (err2, sender) => {
                            if (err2) {
                                return setImmediate(eachSeriesCb, err2);
                            }

                            // DATABASE: write
                            library.logic.transaction.undoUnconfirmed(transaction, sender, eachSeriesCb);
                        });
                    }, err3 => setImmediate(seriesCb, err3 || err));
                } else {
                    return setImmediate(seriesCb);
                }
            });
        },
        // Block and transactions are ok.
        // Apply transactions to confirmed mem_accounts fields.
        applyConfirmed(seriesCb) {
            async.eachSeries(block.transactions, (transaction, eachSeriesCb) => {
                modules.accounts.getAccount({ publicKey: transaction.senderPublicKey }, (err, sender) => {
                    if (err) {
                        // Fatal error, memory tables will be inconsistent
                        err = ['Failed to apply transaction:', transaction.id, '-', err].join(' ');
                        library.logger.error(err);
                        library.logger.error('Transaction', transaction);

                        return process.exit(0);
                    }
                    // DATABASE: write
                    modules.transactions.apply(transaction, block, sender, (errApply) => {
                        if (errApply) {
                            // Fatal error, memory tables will be inconsistent
                            errApply = ['Failed to apply transaction:', transaction.id, '-', errApply].join(' ');
                            library.logger.error(errApply);
                            library.logger.error('Transaction', transaction);

                            return process.exit(0);
                        }
                        // Transaction applied, removed from the unconfirmed list.
                        modules.transactions.removeUnconfirmedTransaction(transaction.id);
                        return setImmediate(eachSeriesCb);
                    });
                });
            }, err => setImmediate(seriesCb, err));
        },
        // Optionally save the block to the database.
        saveBlock(seriesCb) {
            modules.blocks.lastBlock.set(block);

            if (saveBlock) {
                // DATABASE: write
                self.saveBlock(block, (err) => {
                    if (err) {
                        // Fatal error, memory tables will be inconsistent
                        library.logger.error('Failed to save block...', err);
                        library.logger.error('Block', block);

                        return process.exit(0);
                    }

                    library.logger.debug(`Block applied correctly with ${block.transactions.length} transactions`);
                    library.bus.message('newBlock', block, broadcast);

                    // DATABASE write. Update delegates accounts
                    modules.rounds.tick(block, seriesCb);
                });
            } else {
                library.bus.message('newBlock', block, broadcast);

                // DATABASE write. Update delegates accounts
                modules.rounds.tick(block, seriesCb);
            }
        },
        // Push back unconfirmed transactions list (minus the one that were on the block if applied correctly).
        // TODO: See undoUnconfirmedList discussion above.
        applyUnconfirmedIds(seriesCb) {
            // DATABASE write
            modules.transactions.applyUnconfirmedIds(
                Array.from(unconfirmedTransactionIds), err => setImmediate(seriesCb, err)
            );
        },
    }, (err) => {
        // Allow shutdown, database writes are finished.
        modules.blocks.isActive.set(false);

        // Nullify large objects.
        // Prevents memory leak during synchronisation.
        appliedTransactions = null;
        unconfirmedTransactionIds = null;
        block = null;

        // Finish here if snapshotting.
        // FIXME: Not the best place to do that
        if (err === 'Snapshot finished') {
            library.logger.info(err);
            process.emit('SIGTERM');
        }

        return setImmediate(cb, err);
    });
};

Chain.prototype.newApplyBlock = async (block, broadcast, saveBlock, tick) => {
    // Prevent shutdown during database writes.
    modules.blocks.isActive.set(true);

    if (saveBlock) {
        await self.newSaveBlock(block);
        library.logger.debug(`Block applied correctly with ${block.transactions.length} transactions`);
    }

    for (const trs of block.transactions) {
        const sender = await getOrCreateAccount(library.db, trs.senderPublicKey);
        await library.logic.transaction.newApply(trs, block, sender);

        if (saveBlock) {
            trs.blockId = block.id;
            await self.saveTransaction(trs);
        }
    }

    if (saveBlock) {
        await __private.newAfterSave(block);
    }

    modules.blocks.lastBlock.set(block);
    library.bus.message('newBlock', block, broadcast);

    if (tick) {
        await (new Promise((resolve, reject) => modules.rounds.tick(block, (err, message) => {
            if (err) {
                library.logger.error(`[Chain][applyBlock][tick]: ${err}`);
                library.logger.error(`[Chain][applyBlock][tick][stack]: \n ${err.stack}`);
                reject(err);
            }
            library.logger.debug(`[Chain][applyBlock][tick] message: ${message}`);
            resolve();
        })));
    }
    block = null;
};

/**
 * Deletes last block, undo transactions, recalculate round
 *
 * @private
 * @async
 * @method popLastBlock
 * @param  {Function} cbPopLastBlock Callback function
 * @return {Function} cbPopLastBlock Callback function from params (through setImmediate)
 * @return {Object}   cbPopLastBlock.err Error
 * @return {Object}   cbPopLastBlock.obj New last block
 */
__private.popLastBlock = function (oldLastBlock, cbPopLastBlock) {
    // Execute in sequence via balancesSequence
    library.balancesSequence.add((cbAdd) => {
        // Load previous block from full_blocks_list table
        // TODO: Can be inefficient, need performnce tests
        modules.blocks.utils.loadBlocksPart(oldLastBlock.previousBlock, (err, previousBlock) => {
            if (err) {
                return setImmediate(cbAdd, err || 'previousBlock is null');
            }

            // Reverse order of transactions in last blocks...
            async.eachSeries(oldLastBlock.transactions.reverse(), (transaction, cbReverse) => {
                async.series([
                    function (cbGetAccount) {
                        // Retrieve sender by public key
                        modules.accounts.getAccount(
                            { publicKey: transaction.senderPublicKey },
                            (errorGetAccount, sender) => {
                                if (errorGetAccount) {
                                    return setImmediate(cbGetAccount, errorGetAccount);
                                }
                                // Undoing confirmed tx - refresh confirmed balance
                                // (see: logic.transaction.undo, logic.transfer.undo)
                                // WARNING: DB_WRITE
                                modules.transactions.undo(transaction, oldLastBlock, sender, cbGetAccount);
                            });
                    }, function (cbUncomfirmed) {
                        // Undoing unconfirmed tx - refresh unconfirmed balance (see: logic.transaction.undoUnconfirmed)
                        // WARNING: DB_WRITE
                        modules.transactions.undoUnconfirmed(transaction, cbUncomfirmed);
                    }, function (cb) {
                        return setImmediate(cb);
                    }
                ], cbReverse);
            }, (errorUndo) => {
                if (errorUndo) {
                    // Fatal error, memory tables will be inconsistent
                    library.logger.error('Failed to undo transactions', errorUndo);

                    return process.exit(0);
                }

                // Perform backward tick on rounds
                // WARNING: DB_WRITE
                modules.rounds.backwardTick(oldLastBlock, previousBlock, (err) => {
                    if (err) {
                        // Fatal error, memory tables will be inconsistent
                        library.logger.error('Failed to perform backwards tick', err);

                        return process.exit(0);
                    }

                    // Delete last block from blockchain
                    // WARNING: Db_WRITE
                    self.deleteBlock(oldLastBlock.id, (errDeleteBlock) => {
                        if (errDeleteBlock) {
                            // Fatal error, memory tables will be inconsistent
                            library.logger.error('Failed to delete block', errDeleteBlock);

                            return process.exit(0);
                        }

                        return setImmediate(cbAdd, null, previousBlock);
                    });
                });
            });
        });
    }, cbPopLastBlock);
};

/**
 * Deletes last block
 *
 * @public
 * @async
 * @method deleteLastBlock
 * @param  {Function} cb Callback function
 * @return {Function} cb Callback function from params (through setImmediate)
 * @return {Object}   cb.err Error if occurred
 * @return {Object}   cb.obj New last block
 */
Chain.prototype.deleteLastBlock = function (cb) {
    let lastBlock = modules.blocks.lastBlock.get();
    library.logger.warn(`Deleting last block: ${JSON.stringify(lastBlock)}`);

    if (lastBlock.height === 1) {
        return setImmediate(cb, 'Cannot delete genesis block');
    }

    // Delete last block, replace last block with previous block, undo things
    __private.popLastBlock(lastBlock, (err, newLastBlock) => {
        if (err) {
            library.logger.error(`Error deleting last block: ${JSON.stringify(lastBlock)}, message: ${err}`);
        } else {
            // Replace last block with previous
            lastBlock = modules.blocks.lastBlock.set(newLastBlock);
        }
        return setImmediate(cb, err, lastBlock);
    });
};

/**
 * Recover chain - wrapper for deleteLastBlock
 *
 * @private
 * @async
 * @method recoverChain
 * @param  {Function} cb Callback function
 * @return {Function} cb Callback function from params (through setImmediate)
 * @return {Object}   cb.err Error if occurred
 */
Chain.prototype.recoverChain = function (cb) {
    library.logger.warn('Chain comparison failed, starting recovery');
    self.deleteLastBlock((err, newLastBlock) => {
        if (err) {
            library.logger.error('Recovery failed');
        } else {
            library.logger.info('Recovery complete, new last block', newLastBlock.id);
        }
        return setImmediate(cb, err);
    });
};

/**
 * Handle modules initialization:
 * - accounts
 * - blocks
 * - rounds
 * - transactions
 * @param {modules} scope Exposed modules
 */
Chain.prototype.onBind = function (scope) {
    library.logger.trace('Blocks->Chain: Shared modules bind.');
    modules = {
        accounts: scope.accounts,
        blocks: scope.blocks,
        rounds: scope.rounds,
        transactions: scope.transactions,
    };

    // Set module as loaded
    __private.loaded = true;
};

module.exports = Chain;

/** ************************************* END OF FILE ************************************ */
