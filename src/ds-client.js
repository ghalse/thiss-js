const hex_sha1 = require('./sha1.js').default;
const cross_storage = require("cross-storage");
const storage_key = "pyff_discovery_choices";
const cache_time = 60 * 10 * 1000; // 10 minutes

export class LocalStoreShim {
   constructor() {}
   onConnect() {
      return Promise.resolve(this);
   }
   set(key,value) {
      let storage = window.localStorage;
      storage.setItem(key, value);
      return Promise.resolve(this); 
   }
   get(key) {
      let storage = window.localStorage;
      return Promise.resolve(storage.getItem(key));
   };
}

let _querystring = (function(paramsArray) {
   let params = {};

   for (let i = 0; i < paramsArray.length; ++i) {
      let param = paramsArray[i].split('=', 2);
      if (param.length !== 2)
         continue;

      params[param[0]] = decodeURIComponent(param[1].replace(/\+/g, " "));
   }

   return params;
})(window.location.search.substr(1).split('&'));

function _timestamp() {
   if (typeof Date.now === 'function') {
      return Date.now();
   }

   return new Date().getTime();
}

function _touch(entity_id, list) {
    for (let i = 0; i < list.length; i++) {
        let item = list[i];
        if (item.entity.entity_id == entity_id || item.entity.entityID == entity_id) {
            let now = _timestamp();
            let use_count = item.use_count;
            item.use_count += 1;
            item.last_use = now;
            return use_count;
        }
    }
    return -1;
};

function _sha1_id(s) {
    return "{sha1}"+hex_sha1(s);
};

// polyfill Object.values()
if (!Object.values) Object.values = function (object) {
   return Object.keys(object).map(function(key) { return object[key] });
};

function json_mdq_get(id, mdq_url) {
    let opts = {method: 'GET', headers: {}};
    return fetch(mdq_url + id + ".json",opts).then(function (response) {
       if (response.status == 404) {
           throw new URIError("Entity not found in MDQ server");
       }
       return response;
    }).then(function (response) {
        let contentType = response.headers.get("content-type");
        if(contentType && contentType.includes("application/json")) {
            return response.json();
        }
        throw new SyntaxError("MDQ didn't provide a JSON response");
    }).then(function(data) {
        if (Object.prototype.toString.call(data) === "[object Array]") {
            data = data[0];
        }
        return data;
    }).catch(function(error) {
        console.log(error);
        //Promise.reject(error);
    });
};

function parse_storage_url(url) {
    if (url == 'local://') {
        return function() { return new LocalStoreShim() }
    } else {
        return function() { return new cross_storage.CrossStorageClient(url) }
    }
};

export class DiscoveryService {

    constructor(mdq, storage, opts) {
        opts = opts || {};
        if (typeof mdq === 'function') {
            this.mdq = mdq; // must return a Promise resolving to an entity JSON object
        } else {
            this.mdq = function(id) { return json_mdq_get(id, mdq) }
        }
        if (typeof storage === 'function') {
            this.storage = storage; // must be a constructor for a storage class
        } else {
            this.storage = parse_storage_url(storage);
        }
    }

    clean_item(item) {
        if (item.entity && (item.entity.entity_id || item.entity.entityID) && item.entity.title) {
            let entity = item.entity;
            if (entity && entity.entityID && !entity.entity_id) {
               entity.entity_id = entity.entityID;
            }
            if (entity && !entity.entity_icon && entity.icon) {
               entity.entity_icon = entity.icon;
            }
        }
        
        return item;
    }

    with_items(callback) {
        let obj = this;
        let storage = this.storage();
        return storage.onConnect().then(function () {
            console.log("pyFF ds-client: Listing discovery choices");
            return storage.get(storage_key);
        }).then(function(data) {
            data = data || '[]';
            let lst;
            try {
                lst = JSON.parse(data) || [];
            } catch (error) {
                console.log(error);
                lst = [];
            }

            let cleaned_items = {};
            for (let i = 0; i < lst.length; i++) {
                let cleaned_item = this.clean_item(lst[i]);
                cleaned_items[cleaned_item.entity['entity_id']] = cleaned_item;
            }

            lst = Object.values(cleaned_items);

            while (lst.length > 3) {
                lst.pop();
            }

            lst.sort(function (a, b) { // most commonly used last in list
                if (a.last_use < b.last_use) {
                    return -1;
                }
                if (a.last_use > b.last_use) {
                    return 1;
                }
                return 0;
            });

            return Promise.all(lst.map(function(item,i) {
                let now = _timestamp();
                let last_refresh = item.last_refresh || -1;
                if (last_refresh == -1 || last_refresh + cache_time < now) {
                    let id = _sha1_id(item.entity['entity_id'] || item.entity['entityID']);
                    return obj.mdq(id).then(function(entity) {
                        if (entity) {
                            item.entity = entity;
                            item = this.clean_item(item);
                            item.last_refresh = now;
                        }
                        return item;
                    })
                } else {
                    return Promise.resolve(item);
                }
            })).then(callback);
        }).then(function(items) { storage.set(storage_key, JSON.stringify(items))});
    }

    saml_discovery_response(entity_id) {
        let params = _querystring;
        return this.do_saml_discovery_response(entity_id, params).then(function (url) {
            window.location = url;
        });
    }

    pin(entity_id) {
        return this.do_saml_discovery_response(entity_id, {});
    }

    do_saml_discovery_response(entity_id, params) {
        let obj = this;
        return obj.with_items(function(items) {
            if (_touch(entity_id, items) == -1) {
                return obj.mdq(_sha1_id(entity_id)).then(function (entity) {
                    console.log("mdq found entity: ", entity);
                    let now = _timestamp();
                    items.push({last_refresh: now, last_use: now, use_count: 1, entity: entity});
                    return items;
                });
            } else {
                return Promise.resolve(items);
            }
        }).then(function() {
            let qs;
            if (params['return']) {
                console.log("returning discovery response...");
                qs = params['return'].indexOf('?') === -1 ? '?' : '&';
                let returnIDParam = params['returnIDParam'];
                if (!returnIDParam) {
                    returnIDParam = "entityID";
                }
                let response = params['return'];
                if (entity_id) {
                    response += qs + returnIDParam + '=' + entity_id;
                }
                console.log(response);
                return response;
            }
        });
    }

    remove(id) {
        return this.with_items(function (items) {
           return items.filter(function(item) {
                return item.entity.entity_id != id && item.entity.entityID != id;
           })
        });
    }

}
