import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants'
import * as Device from 'expo-device';
import { Platform } from 'react-native';

export async function registerForPushNotificationsAsync(): Promise<string | null> {
  if (!Device.isDevice) {
    console.log('Must use physical device for Push Notifications');
    return null;
  }
  const settings = await Notifications.getPermissionsAsync();
  let finalStatus = (settings as any).status;
  if (finalStatus !== 'granted') {
    const response = await Notifications.requestPermissionsAsync();
    finalStatus = (response as any).status;
  }
  if (finalStatus !== 'granted') {
    console.log('Failed to get push token for push notification!');
    return null;
  }

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#FF231F7C',
    });
  }

  console.log('Registering for push notifications...');
  const projectId = Constants?.expoConfig?.extra?.eas?.projectId ?? Constants?.easConfig?.projectId;
  const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  console.log('Push notification token:', token);
  return token;
}
