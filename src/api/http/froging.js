const Router = require('../../helpers/router');
const httpApi = require('../../helpers/httpApi');

/**
 * Binds api with modules and creates common url.
 * - End point: `/api/frogings`
 * - Public API:
 - post /freeze
 - get /count
 - post /getAllOrders
 - post /getAllActiveOrders
 - get /countStakeholders
 - get /getTotalDDKStaked
 - post /getMyDDKFrozen
 * @memberof module:frogings
 * @requires helpers/Router
 * @requires helpers/httpApi
 * @constructor
 * @param {Object} frogingsModule - Module transaction instance.
 * @param {scope} app - Network app.
 */
// Constructor
function FrogingsHttpApi(frogingsModule, app, logger, cache) {
    const router = new Router();

    // attach a middlware to endpoints
    router.attachMiddlwareForUrls(httpApi.middleware.useCache.bind(null, logger, cache), [
        'get /'
    ]);

    router.map(frogingsModule.shared, {

        'post /freeze': 'addTransactionForFreeze',
        'get /count': 'getFrozensCount',
        'post /getAllOrders': 'getAllFreezeOrders',
        'post /getAllActiveOrders': 'getAllActiveFreezeOrders',
        'get /countStakeholders': 'countStakeholders',
        'get /getTotalDDKStaked': 'totalDDKStaked',
        'post /getMyDDKFrozen': 'getMyDDKFrozen',
        'get /getRewardHistory': 'getRewardHistory'
    });

    httpApi.registerEndpoint('/api/frogings', app, router, frogingsModule.isLoaded);
}

module.exports = FrogingsHttpApi;

/** ************************************* END OF FILE ************************************ */
