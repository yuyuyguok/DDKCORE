

/* 
*  script that runs every fist day of a month and archives log files and removes them from the 
*  project's logs directory. 
*/

// requiring modules and initializing required variables.
let fs = require('fs'),
	path = require('path'),
	archiver = require('archiver'),
	currDate = new Date(),
	ignoredFile = currDate.getFullYear()+'-'+('0' + (currDate.getMonth() + 1)).slice(-2)+'-'+('0' + currDate.getDate()).slice(-2)+'.log';

//Function to create directories recursively if doesn't exists.
exports.createDir = function (dir, cb) {
	try {
		const splitPath = dir.split('/');
		splitPath.reduce(function (dirPath, subPath) {
			let currentPath;
			if (subPath != '.') {
				currentPath = dirPath + '/' + subPath;
				if (!fs.existsSync(currentPath)) {
					fs.mkdirSync(currentPath);
				}
			} else {
				currentPath = subPath;
			}
			return currentPath;
		}, '');
		return cb(null);
	} catch(err) {
		return cb(err);
	}
};

// function to archive log files and removes from project's logs directory.
exports.archiveLogFiles = function(dir, cb) {
    
	// create a file to stream archive data to.
	let output = fs.createWriteStream(path.join(dir, currDate.getTime() + '.zip'));
	let archive = archiver('zip', {});
	let logPath = __dirname + '/logs';

	// listen for all archive data to be written.
	// 'close' event is fired only when a file descriptor is involved.
	// deleting files from @logs directory when all files written to the archived directory.
	output.on('close', function () {
		try {
			if (fs.existsSync(logPath)) {
				fs.readdirSync(logPath).forEach(function (file) {
					let curPath = logPath + '/' + file;
					if (!fs.lstatSync(logPath).isFile()) {
						// delete file
						if(!(file == ignoredFile || file == 'archive.log')) {
							fs.unlinkSync(curPath);
						}
					}
				});
			}
			return cb(null);
		} catch(err) {
			return cb(err);
		}
	});

	// This event is fired when the data source is drained no matter what was the data source.
	// It is not part of this library but rather from the NodeJS Stream API.
	// @see: https://nodejs.org/api/stream.html#stream_event_end
	output.on('end', function () {});

	// good practice to catch warnings (ie stat failures and other non-blocking errors)
	archive.on('warning', function (err) {
		if (err.code === 'ENOENT') {
			return cb(err);
		} else {
			return cb(err);
		}
	});

	// good practice to catch this error explicitly
	archive.on('error', function (err) {
		return cb(err);
	});

	// pipe archive data to the file
	archive.pipe(output);

	// append files from a glob pattern
	archive
		.glob('./logs/**/*', {
			ignore: ['./logs/'+ignoredFile, './logs/archive.log']
		})
		.finalize();
};