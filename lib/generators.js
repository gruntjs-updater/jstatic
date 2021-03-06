module.exports = function(jstatic) {
    var path = require("path");
    var jsYaml = require("js-yaml");
    var marked = require("marked");
    var swig = require("swig");
    var grunt = require("grunt");
    var _ = grunt.util._;

    jstatic.registerGenerator("yafm", function(iter, params, flow, depends, data) {
        var sep = params.sep || "-";
        var re = "(" + sep + "{3,})([\\w\\W]+?)" + sep + "{3,}";
        var multi = params.multi?true:false;
        if(!multi) {
            re = "^" + re;
        }
        re = new RegExp(re, "g");

        var newEntries = [];

        return function() {
            if(newEntries.length > 0) {
                return newEntries.shift();
            }

            var entry = iter();
            if(_.isUndefined(entry)) return;

            var splits = _.chain(entry.content.split(re)).map(_.trim).filter(function(split) {
                return split.length > 0;
            }).value();
            for(var i = 0;i < splits.length;i++) {
                var newEntry = _.clone(entry);
                if(splits[i].substring(0, 4) === sep + sep + sep) {
                    i++; // skip the separator
                    try {
                        var yaml = jsYaml.load(splits[i]);
                        _.extend(newEntry, yaml);
                    } catch(e) {
                        grunt.log.warn("generator#yafm: Couldnt parse yaml front matter " + e + "\n" + splits[i]);
                    }
                    i++; // position at the content
                }
                newEntry.content = splits[i] || "";
                if(multi) {
                    newEntry.split = newEntries.length;
                    if(flow.dest) {
                        var newName = newEntry.basename + newEntries.length + flow.outExt;
                        newEntry.destPath = path.join(flow.dest, newName);
                    }
                }
                newEntries.push(newEntry);
            }

            return newEntries.shift();
        };
    });

    jstatic.registerGenerator("paginator", function(iter, params, flow, depends) {
        var pivot = params.pivot;
        var pageSize = params.pageSize || 5;
        if(_.isUndefined(pivot)) {
            grunt.fail.warn("generator#paginator: pivot field required. specify a name from the depends list, to be used as paginatination pivot.");
        }

        var pageBy = params.pageBy || function(entry, index) {
            return Math.floor(index/pageSize)+1;
        };

        var pages, entry, pageCount;

        var paginatorIter = function() {
            if(pages && pages.length) {
                var page = pages.shift();
                var newEntry = _.clone(entry);
                newEntry.page = page[0];
                newEntry.pageItems = page[1];
                newEntry.pageCount = pageCount;
                newEntry.pageSize = pageSize; // TODO: deprecate

                if(flow.dest) {
                    var newName = newEntry.basename + newEntry.page + flow.outExt;
                    newEntry.destPath = path.join(flow.dest, newName);
                }
                return newEntry;
            }

            entry = iter();
            if(_.isUndefined(entry)) return;

            pages = [];
            _.each(depends[pivot], function(entry, index) {
                var groupKey = pageBy(entry, index);
                var group = _.find(pages, function(group) {
                    return _.isEqual(group[0], groupKey);
                });
                if(group) {
                    group[1].push(entry);
                } else {
                    pages.push([groupKey, [entry]]);
                }
            });
            pageCount = pages.length;
            return paginatorIter();
        };

        return paginatorIter;
    });

    jstatic.registerGenerator("sequencer", function(iter, params, flow, depends, data) {
        var collected = false;
        var sequence = [];
        var index = 0;
        var insertRefs = _.isUndefined(params.insertRefs)?true:params.insertRefs;

        return function() {
            if(collected) {
                if(index < sequence.length) {
                    return sequence[index++];
                } else {
                    return;
                }
            }
            var entry;
            while(entry = iter()) {
                sequence.push(entry);
            }
            if(params.sortBy) {
                sequence = _.sortBy(sequence, params.sortBy);
            }
            if(params.reverse) {
                sequence.reverse();
            }
            for(var i = 0;i < sequence.length;i++) {
                entry = sequence[i];
                if(insertRefs) {
                    if(i != 0) {
                        entry.prev = sequence[i-1];
                    }
                    if(i != sequence.length-1) {
                        entry.next = sequence[i+1];
                    }
                }
                entry.sequence = sequence;
            }
            collected = true;

            return sequence[index++];
        };
    });

    jstatic.registerGenerator("destination", function(iter, params, flow, depends, data) {
        var pathFunc;
        if(_.isString(params.dest)) {
            pathFunc = function(entry, outExt, sep, dest) {
                var context = _.extend({sep: sep, outExt: outExt, dest: dest}, entry);
                return _.template(params.dest, context, {
                    interpolate: /\$\((.+?)\)/g
                });
            }
        } else if(_.isFunction(params.dest)){
            pathFunc = params.dest;
        } else {
            grunt.fail.warn("generator#destination: dest parameter must be string or a function");
        }

        return function() {
            var entry = iter();
            if(_.isUndefined(entry)) return;

            // override the destination path
            entry.destPath = path.join(flow.dest, pathFunc(entry, flow.outExt, path.sep, flow.dest));
            return entry;
        };
    });

    jstatic.registerGenerator("permalink", function(iter, params, flow, depends, data) {
        params = _.defaults(params, {
            linkPrefix: "/",
            linkPathStrip: 1,
        });

        var linkFunc;
        if(_.isString(params.link)) {
            linkFunc = function(entry, prefix, pathElems, outExt, dest) {
                var context = _.extend({
                    prefix: prefix,
                    pathElems: pathElems,
                    outExt: outExt,
                    dest: dest
                }, entry);
                return _.template(params.func, context, {
                    interpolate: /\$\((.+?)\)/g
                });
            };
        } else if(_.isFunction(params.link)) {
            linkFunc = params.link;
        } else if(_.isUndefined(params.link)) {
            linkFunc = function(entry, prefix, pathElems, outExt, dest) {
                return prefix + pathElems.join("/");
            };
        } else {
            grunt.fail.warn("generator#permalink: parameter link must be a function or a string");
        }

        return function() {
            var entry = iter();
            if(_.isUndefined(entry)) return;


            // create the permalink
            var destPathSplits, sliceEnd, destBasename;

            if(entry.destPath) {
                destPathSplits = entry.destPath.split(path.sep);
                sliceEnd = destPathSplits.length;
                destBasename = path.basename(entry.destPath, path.extname(entry.destPath))
                if(destBasename === "index") {
                    sliceEnd--;
                }
            } else {
                destPathSplits = [];
                sliceEnd = 0;
                destBasename = "";
            }
            entry.permalink = linkFunc(entry, params.linkPrefix, destPathSplits.slice(params.linkPathStrip, sliceEnd), flow.outExt);
            return entry;
        };
    });

    jstatic.registerGenerator("unpublish", function(iter, params, flow, depends, data) {
        return function() {
            var entry;
            while(
                (entry = iter()) &&
                !_.isUndefined(entry.published) && 
                !entry.published
            );
            return entry;
        };
    });

    jstatic.registerGenerator("summary", function(iter, params, flow, depends, data) {
        var rHeading = /(^(.+)\n(-|=){3,}$)|(^#+.+$)/mg; //2
        var rLinkImg = /!?\[([^\]]+)\]((\([^\)]+\))|(\[\d+\]))/mg; //1
        var rLinkRef = /^\[\d+\]:.+$/mg;
        
        return function() {
            var entry = iter();
            if(_.isUndefined(entry)) return;

            var summary = entry.content.replace(rHeading, "")    // strip headings
                                       .replace(rLinkImg, "$1")  // replace links with text
                                       .replace(rLinkRef, "")    // strip link refs
                                       .split(/\n{2,}/mg);       // take first paragraph*/

            entry.summary = _.find(summary, function(line) {
                return _.trim(line).length > 0;
            });
            if(entry.link) {
                entry.summary += "<a href='"+context.permalink+"'> ... read more</a>";
            }
            return entry;
        };
    });

    jstatic.registerGenerator("markdown", function(iter, params, flow, depends, data) {
        return function() {
            var entry = iter();
            if(_.isUndefined(entry)) return;

            entry.content = marked(entry.content);
            return entry;
        };
    });

    jstatic.registerGenerator("passthru", function(iter, params, flow, depends, data) {
        var pass = params.pass;
        if(_.isUndefined(pass)) {
            grunt.fail.warn("generator#passthru: paramter 'pass' should be a function.");
        }
        return function() {
            var entry = iter();
            if(_.isUndefined(entry)) return;
            var newEntry = pass(entry, params, flow, depends, data);
            return newEntry || entry;
        };
    });

    swig.setFilter("jsonStringify", function(arg) {
        return JSON.stringify(arg);
    });
    swig.setFilter("head", function(arr, count) {
        return _.first(arr, count);
    });
    swig.setFilter("tail", function(arr, count) {
        return _.last(arr, count);
    });
    swig.setFilter("sortBy", function(arr, property, reverse) {
        var sorted = _.sortBy(arr, property);
        if(reverse) {
            sorted.reverse();
        }
        return sorted;
    });
    swig.setFilter("having", function(arr, property, value) {
        return _.filter(arr, function(item) {
            if(_.isUndefined(value)) {
                return !_.isUndefined(item[property]);
            } else {
                return item[property] == value;
            }
        });
    });
    swig.setFilter("alt", function(value) {
        return ((value % 2) == 0);
    });
    swig.setFilter("pageSlice", function(arr, page, pageSize) {
        var start = (page-1)*pageSize;
        return arr.slice(start, start + pageSize);
    });
    swig.setFilter("truncate", function(str, len, ellipsis) {
        ellipsis = ellipsis || "...";
        if(str.length > len) {
            return str.substring(0, len) + ellipsis;
        } else {
            return str;
        }
    });

    jstatic.registerGenerator("swig", function(iter, params, flow, depends, data) {
        var layout;
        if(params.layout) {
            layout = swig.compileFile(params.layout, _.extend({filename: params.layout}, params));
        }

        return function() {
            var entry = iter();
            if(_.isUndefined(entry)) return;

            var context = _.extend({}, entry, depends, data);
            var result;
            if(params.layoutOnly) {
                result = entry.content;
            } else {
                var template = swig.compile(entry.content, _.extend({filename: entry.srcPath}, params));
                result = template(context);
            }

            if(layout) {
                var newContext = _.extend({body: result}, context);
                result = layout(newContext);
            }
            
            entry.content = result;
            return entry;
        };
    });
};
