const sharp = require('sharp');
const thumbnailWidth = 220;

module.exports = {
    generateImageThumbnail: async function (file, resultFile) {
        return sharp(file)
            .resize(thumbnailWidth)
            .toFile(resultFile);
    },

    crop: async function (filename, rect) {
        return sharp(filename)
            .extract({ left: rect.left, top: rect.top, width: rect.width, height: rect.height })
            .toFile(filename);
    },

    webp: async function (filename, filenameResult) {
        return sharp(filename)
            .webp({ quality: 95 })
            .toFile(filenameResult);
    },

    createErrorImage: async function (filename, errorText, width = 1024) {
        let textArr = errorText.replace(/'/gi, "`").match(/.{1,90}/g);
        errorText = textArr.join("\n");

        return sharp({
            create: {
                width: width,
                height: 600,
                channels: 4,
                background: { r: 255, g: 255, b: 255, alpha: 1 }
            }
        })
            .composite([{
                input: Buffer.from(`<svg width="${width}" height="600"><text x="10" y="20" font-family="Verdana" font-size="20" fill="black">${errorText}</text></svg>`),
                top: 0,
                left: 0
            }])
            .png()
            .toFile(filename);
    },
};
