import * as functions from 'firebase-functions';
import {timingSafeEqual} from 'crypto';

// // Start writing Firebase Functions
// // https://firebase.google.com/docs/functions/typescript
//
// export const helloWorld = functions.https.onRequest((request, response) => {
//   functions.logger.info('Hello logs!', {structuredData: true});
//   response.send('Hello from Firebase!');
// });

import * as admin from 'firebase-admin';
admin.initializeApp();

export const addTimestamp = functions.firestore.document('/shares/{recipientId}/{recipientProfileId}/{shareId}').onCreate((snap, ctx) => {
    const recipientId = ctx.params.recipientId;

    const createdAtMillis = admin.firestore.Timestamp.now().toMillis();
    const createdAt = new Date(createdAtMillis);

    admin.firestore().collection('shares').doc(recipientId).set({
        last_share_received_at: createdAt,
    });

    return snap.ref.set({
        created_at: createdAt,
    }, {merge: true});
});

export const deleteShares = functions.https.onRequest(async (request, response) => {
    const fallbackMaxShareAge = 1 * 24 * 60 * 60 * 1000;
    const fallbackAgeThreshold = 2 * 24 * 60 * 60 * 1000;
    const {maxShareAge, ageThreshold, key} = request.query;
    const correctKey = functions.config().cron.key;

    if (!correctKey || !key || (key as string).length !== correctKey.length ||
        !timingSafeEqual(Buffer.from(key as string), Buffer.from(correctKey))) {
        functions.logger.warn('Key in request and in env do NOT match!');
        response.status(403).send('Access denied');
        return;
    }

    const olderThanHoursNum = Number.parseInt(maxShareAge as string);
    const ageThresholdNum = Number.parseInt(ageThreshold as string);

    const createdAtMillis = admin.firestore.Timestamp.now().toMillis();

    const maxShareAgeDate = new Date(createdAtMillis - (Number.isNaN(olderThanHoursNum) ? fallbackMaxShareAge : olderThanHoursNum));
    const ageThresholdDate = new Date(createdAtMillis - (Number.isNaN(ageThresholdNum) ? fallbackAgeThreshold : ageThresholdNum));

    let sharesDeleted = 0;
    try {
        const recipientUserDocs = await admin.firestore().collection('shares').where('last_share_received_at', '>', ageThresholdDate).get();
        for (const recipientUserDoc of recipientUserDocs.docs) {
            try {
                const profileCollections = await admin.firestore().collection('shares').doc(recipientUserDoc.id).listCollections();
                for (const profileCollection of profileCollections) {
                    try {
                        const shareDocs = await profileCollection.where('created_at', '<', maxShareAgeDate).get();
                        for (const shareDoc of shareDocs.docs) {
                            try {
                                shareDoc.ref.delete();
                                sharesDeleted++;
                            } catch (e1) {
                                functions.logger.error(`Failed to delete share: ${recipientUserDoc.id}/${profileCollection.id}/${shareDoc.id}.`, e1);
                            }
                        }
                    } catch (e2) {
                        functions.logger.error(
                            `Failed to get shares older than ${maxShareAgeDate} in ${recipientUserDoc.id}/${profileCollection.id}.`, e2
                        );
                    }
                }
            } catch (e3) {
                functions.logger.error(`Failed to get profiles in user ${recipientUserDoc.id}.`, e3);
            }
        }
    } catch (e4) {
        functions.logger.error(`Failed to get users that received a share since ${ageThresholdDate}.`, e4);
    } finally {
        response.send(`Deleted ${sharesDeleted} shares.`);
    }
});
