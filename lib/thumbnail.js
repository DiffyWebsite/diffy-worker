const im = require('imagemagick');
const thumbnailWidth = 220;

module.exports = {
    generateImageThumbnail: async function (file, resultFile) {
        return new Promise(function (res, rej) {
            im.resize({
                srcPath: file,
                dstPath: resultFile,
                width: thumbnailWidth
            }, function (err) {
                if (err) {
                    rej(err);
                } else {
                    res();
                }
            });
        });
    },

    crop: async function (filename, rect) {
        return new Promise(function (res, rej) {
            im.convert([
                `${filename}`,
                `-crop`,
                `${rect.width}x${rect.height}+${rect.left}+${rect.top}`,
                `${filename}`,
            ], (err) => {
                if (err) {
                    rej(err);
                } else {
                    res();
                }
            });
        });
    },

    webp: async function (filename, filenameResult) {
      return new Promise(function (res, rej) {
        im.convert([
          `${filename}`,
          `-quality`,
          95,
          `${filenameResult}`,
        ], (err) => {
          err ? rej(err) : res();
        });
      });
    },

    createErrorImage: async function (filename, errorText, width = 1024) {
        let textArr;

        errorText = errorText.replace(/'/gi, "`");
        textArr = errorText.match(/.{1,90}/g);
        errorText = textArr.join("\n")

        return new Promise(function (res, rej) {
            im.convert([
                `-size`,
                `${width}x600`,
                `xc:white`,
                `-font`,
                `Verdana`,
                `-pointsize`,
                `20`,
                `-gravity`,
                `center`,
                `-draw`,
                `text 0,0 '${errorText}'`,
                `${filename}`,
            ], (err) => {
                if (err) {
                    rej(err);
                } else {
                    res();
                }
            });
        });
    },
};
